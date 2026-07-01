import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getLevelingConfig, getUserLevelData } from '../services/leveling.js';
import { addXp } from '../services/xpSystem.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { parsePrefixCommand } from '../utils/prefixParser.js';
import { supportsPrefixExecution, executePrefixCommand, resolvePrefixAccessKey } from '../utils/messageAdapter.js';
import { resolveCommandAlias, resolveSubcommandAlias } from '../config/commandAliases.js';
import { getPrefixRestriction } from '../config/prefixRestrictions.js';
import { getGuildConfig } from '../services/guildConfig.js';
import { enforceAbuseProtection, formatCooldownDuration } from '../utils/abuseProtection.js';
import { createEmbed } from '../utils/embeds.js';
import { isCommandEnabled } from '../services/commandAccessService.js';
import {
  getCountingGameConfig,
  saveCountingGameConfig,
  isValidCountingMessage,
  recordCorrectCount,
} from '../services/countingGameService.js';

const MESSAGE_XP_RATE_LIMIT_ATTEMPTS = 12;
const MESSAGE_XP_RATE_LIMIT_WINDOW_MS = 10000;

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    try {
      if (message.author.bot || !message.guild) return;

      // 1. معالجة اختصار الموسيقى أولاً
      const magicExecuted = await interceptMagicPlay(message, client);
      if (magicExecuted) return;

      // 2. باقي الوظائف الأساسية
      const countingProcessed = await handleCountingGame(message, client);
      if (countingProcessed) return;

      await handlePrefixCommand(message, client);
      await handleLeveling(message, client);
    } catch (error) {
      logger.error('Error in messageCreate event:', error);
    }
  }
};

// الدالة السحرية المحدثة
async function interceptMagicPlay(message, client) {
    let content = message.content.trim();
    if (!content.toLowerCase().startsWith('p ')) return false;

    let songQuery = content.slice(2).trim();
    if (!songQuery) return false;

    const userVC = message.member?.voice?.channelId;
    const botMember = message.guild.members.cache.get(client.user.id);
    const botVC = botMember?.voice?.channelId;

    if (!userVC || botVC !== userVC) {
        await message.react('👀').catch(() => {});
        return true; 
    }

    const command = client.commands.get('play');
    if (!command) return false;

    await message.react('🎵').catch(() => {});

    const mockInteraction = {
        options: {
            getString: () => songQuery
        },
        guild: message.guild,
        channel: message.channel,
        user: message.author,
        member: message.member,
        client: client,
        deferred: false,
        replied: false,
        deferReply: async () => { mockInteraction.deferred = true; },
        editReply: async (options) => await message.channel.send(options).catch(() => {}),
        reply: async (options) => { 
            mockInteraction.replied = true; 
            return await message.channel.send(options).catch(() => {}); 
        },
        followUp: async (options) => await message.channel.send(options).catch(() => {})
    };

    try {
        await command.execute(mockInteraction, null, client);
        return true;
    } catch (err) {
        logger.error(`[MAGIC PLAY ERROR]: ${err.message}`);
        return true; 
    }
}

async function handlePrefixCommand(message, client) {
  try {
    const guildConfig = await getGuildConfig(client, message.guild.id);
    const prefix = guildConfig?.prefix || client.config.bot.prefix || '!';
    const parsed = parsePrefixCommand(message.content, prefix);
    
    if (!parsed) return; 

    let { commandName, args } = parsed;
    const resolvedCommandName = resolveCommandAlias(commandName);
    const command = client.commands.get(resolvedCommandName);

    if (!command) return; 

    const restriction = getPrefixRestriction(command, args, resolveSubcommandAlias);
    if (!supportsPrefixExecution(command) || restriction.blocked) {
      if (restriction.blocked && restriction.reason) {
        const embed = createEmbed({
          title: 'Slash Command Only',
          description: `${restriction.reason}\nUse \`/${resolvedCommandName}\` instead.`,
          color: 'info',
        });
        await message.channel.send({ embeds: [embed] }).catch(() => {});
      }
      return;
    }

    if (!(await isCommandEnabled(client, message.guild.id, resolvePrefixAccessKey(command.data, args), command.category))) {
      return;
    }

    const mockInteractionForProtection = { guildId: message.guild.id, user: message.author };
    const abuseProtection = await enforceAbuseProtection(mockInteractionForProtection, command, resolvedCommandName);
    
    if (!abuseProtection.allowed) {
      const formattedCooldown = formatCooldownDuration(abuseProtection.remainingMs);
      const embed = createEmbed({
        title: 'Command Cooldown',
        description: `This command is on cooldown. Please wait ${formattedCooldown} before trying again.`,
        color: 'error',
      });
      await message.channel.send({ embeds: [embed] }).catch(() => {});
      return;
    }

    await executePrefixCommand(command, message, args, client, prefix, guildConfig);
  } catch (error) {
    logger.error('Error handling prefix command:', error);
  }
}

async function handleCountingGame(message, client) {
  try {
    const config = await getCountingGameConfig(client, message.guild.id);
    if (!config.enabled || !config.channelId || message.channel.id !== config.channelId) {
      return false;
    }

    const content = message.content.trim();
    const validCount = isValidCountingMessage(content, config);
    const invalidAttempt = !validCount || message.author.id === config.lastUserId;

    if (invalidAttempt) {
      await message.delete().catch(() => {});
      await saveCountingGameConfig(client, message.guild.id, {
        ...config,
        nextNumber: 1,
        lastUserId: null,
        currentStreak: 0,
      });

      const failureMessage = await message.channel.send(`❌ Count broken by <@${message.author.id}>. The sequence has been reset to **1**.`);
      setTimeout(() => { failureMessage.delete().catch(() => {}); }, 10000);
      return true;
    }

    await recordCorrectCount(client, message.guild.id, message.author.id);
    return true;
  } catch (error) {
    logger.error('Error handling counting game:', error);
    return false;
  }
}

async function handleLeveling(message, client) {
  try {
    const rateLimitKey = `xp-event:${message.guild.id}:${message.author.id}`;
    const canProcess = await checkRateLimit(rateLimitKey, MESSAGE_XP_RATE_LIMIT_ATTEMPTS, MESSAGE_XP_RATE_LIMIT_WINDOW_MS);
    if (!canProcess) return;

    const levelingConfig = await getLevelingConfig(client, message.guild.id);
    if (!levelingConfig?.enabled) return;
    if (levelingConfig.ignoredChannels?.includes(message.channel.id)) return;

    if (levelingConfig.ignoredRoles?.length > 0) {
      const member = await message.guild.members.fetch(message.author.id).catch(() => null);
      if (member && member.roles.cache.some(role => levelingConfig.ignoredRoles.includes(role.id))) return;
    }

    if (levelingConfig.blacklistedUsers?.includes(message.author.id)) return;
    if (!message.content || message.content.trim().length === 0) return;

    const userData = await getUserLevelData(client, message.guild.id, message.author.id);
    const cooldownTime = levelingConfig.xpCooldown || 60;
    const now = Date.now();
    
    if (now - (userData.lastMessage || 0) < cooldownTime * 1000) return;

    const minXP = Math.max(1, levelingConfig.xpRange?.min || levelingConfig.xpPerMessage?.min || 15);
    const maxXP = Math.max(minXP, levelingConfig.xpRange?.max || levelingConfig.xpPerMessage?.max || 25);

    let finalXP = Math.floor(Math.random() * (maxXP - minXP + 1)) + minXP;
    if (levelingConfig.xpMultiplier && levelingConfig.xpMultiplier > 1) {
      finalXP = Math.floor(finalXP * levelingConfig.xpMultiplier);
    }

    const result = await addXp(client, message.guild, message.member, finalXP);
    if (result.success && result.leveledUp) {
      logger.info(`${message.author.tag} leveled up to level ${result.level} in ${message.guild.name}`);
    }
  } catch (error) {
    logger.error('Error handling leveling for message:', error);
  }
}
if (firstWord !== 'play') {
        const resolved = resolveCommandAlias(firstWord);
        const isMusicShortcut = new Set(['leave', 'pause', 'resume', 'skip', 'stop', 'volume', 'queue']).has(firstWord);
        if (client.commands.has(resolved) || isMusicShortcut) {
            return false; 
        }
    }

    // 🛑 الحماية من تعدد البوتات (Voice Channel Lock)
    const userVC = message.member?.voice?.channelId;
    const botVC = message.guild.members.me.voice.channelId;

    // إذا لم تكن في روم صوتي، أو كان هذا البوت بالذات غير موجود في نفس الروم، يتم تجاهل الأمر
    // هذا يمنع البوتات الأخرى (مثل Night أو Reminder) من الرد والتداخل
    if (!userVC || botVC !== userVC) {
        return true; 
    }

    const command = client.commands.get('play');
    if (!command) return false;

    logger.info(`[FAST PLAY] Executing for bot in VC. Query: ${songQuery}`);

    // 🛡️ التفاعل الوهمي الشامل (تم إضافة الخصائص الناقصة لمنع رسالة Something Went Wrong)
    const mockInteraction = {
        type: 2, 
        id: message.id,
        applicationId: client.user.id,
        token: 'mock-token',
        createdAt: message.createdAt,
        createdTimestamp: message.createdTimestamp,
        isChatInputCommand: () => true,
        isCommand: () => true,
        isRepliable: () => true, // مهم جداً للمكتبات الصوتية
        commandName: 'play',
        options: {
            data: [{ name: 'query', type: 3, value: songQuery }],
            getSubcommand: () => null,
            getString: () => songQuery,
            get: (name) => ({ name, value: songQuery, type: 3 }),
            getBoolean: () => null,
            getInteger: () => null,
            getNumber: () => null,
            getUser: () => null,
            getMember: () => null,
            getChannel: () => null,
            getRole: () => null,
            getMentionable: () => null,
            getAttachment: () => null,
        },
        guildId: message.guild.id,
        guild: message.guild,
        channelId: message.channel.id,
        channel: message.channel,
        user: message.author,
        member: message.member,
        client: client,
        deferred: false,
        replied: false,
        ephemeral: false,
        deferReply: async () => { 
            mockInteraction.deferred = true; 
            return { interaction: mockInteraction }; 
        },
        editReply: async (options) => await message.channel.send(options).catch(() => {}),
        reply: async (options) => { 
            mockInteraction.replied = true; 
            return await message.channel.send(options).catch(() => {}); 
        },
        followUp: async (options) => await message.channel.send(options).catch(() => {}),
        fetchReply: async () => message,
        deleteReply: async () => {}
    };

    try {
        await command.execute(mockInteraction, client);
        return true;
    } catch (err) {
        logger.error(`[FAST PLAY ERROR]: ${err.message}`);
        // محاولة تنفيذ كأمر نصي عادي في حال فشل التفاعل الوهمي المتقدم
        try {
            const guildConfig = await getGuildConfig(client, message.guild.id);
            await executePrefixCommand(command, message, [songQuery], client, 'p', guildConfig);
        } catch (prefixErr) {
            logger.error(`[FAST PLAY FALLBACK ERROR]: ${prefixErr.message}`);
        }
        return true; 
    }
}

// ... باقي الدوال الأساسية (handlePrefixCommand, handleCountingGame, handleLeveling) 
// موجودة في أسفل الملف تماماً كما هي بدون تغيير لتجنب أي مشاكل.

async function handlePrefixCommand(message, client) {
  try {
    const guildConfig = await getGuildConfig(client, message.guild.id);
    const prefix = guildConfig?.prefix || client.config.bot.prefix || '!';
    const parsed = parsePrefixCommand(message.content, prefix);
    
    if (!parsed) return; 

    let { commandName, args } = parsed;
    const resolvedCommandName = resolveCommandAlias(commandName);
    const command = client.commands.get(resolvedCommandName);

    if (!command) return; 

    const restriction = getPrefixRestriction(command, args, resolveSubcommandAlias);
    if (!supportsPrefixExecution(command) || restriction.blocked) {
      if (restriction.blocked && restriction.reason) {
        const embed = createEmbed({
          title: 'Slash Command Only',
          description: `${restriction.reason}\nUse \`/${resolvedCommandName}\` instead.`,
          color: 'info',
        });
        await message.channel.send({ embeds: [embed] }).catch(() => {});
      }
      return;
    }

    if (!(await isCommandEnabled(client, message.guild.id, resolvePrefixAccessKey(command.data, args), command.category))) {
      return;
    }

    const mockInteractionForProtection = { guildId: message.guild.id, user: message.author };
    const abuseProtection = await enforceAbuseProtection(mockInteractionForProtection, command, resolvedCommandName);
    
    if (!abuseProtection.allowed) {
      const formattedCooldown = formatCooldownDuration(abuseProtection.remainingMs);
      const embed = createEmbed({
        title: 'Command Cooldown',
        description: `This command is on cooldown. Please wait ${formattedCooldown} before trying again.`,
        color: 'error',
      });
      await message.channel.send({ embeds: [embed] }).catch(() => {});
      return;
    }

    await executePrefixCommand(command, message, args, client, prefix, guildConfig);
  } catch (error) {
    logger.error('Error handling prefix command:', error);
  }
}

async function handleCountingGame(message, client) {
  try {
    const config = await getCountingGameConfig(client, message.guild.id);
    if (!config.enabled || !config.channelId || message.channel.id !== config.channelId) {
      return false;
    }

    const content = message.content.trim();
    const validCount = isValidCountingMessage(content, config);
    const invalidAttempt = !validCount || message.author.id === config.lastUserId;

    if (invalidAttempt) {
      await message.delete().catch(() => {});
      await saveCountingGameConfig(client, message.guild.id, {
        ...config,
        nextNumber: 1,
        lastUserId: null,
        currentStreak: 0,
      });

      const failureMessage = await message.channel.send(`❌ Count broken by <@${message.author.id}>. The sequence has been reset to **1**.`);
      setTimeout(() => { failureMessage.delete().catch(() => {}); }, 10000);
      return true;
    }

    await recordCorrectCount(client, message.guild.id, message.author.id);
    return true;
  } catch (error) {
    logger.error('Error handling counting game:', error);
    return false;
  }
}

async function handleLeveling(message, client) {
  try {
    const rateLimitKey = `xp-event:${message.guild.id}:${message.author.id}`;
    const canProcess = await checkRateLimit(rateLimitKey, MESSAGE_XP_RATE_LIMIT_ATTEMPTS, MESSAGE_XP_RATE_LIMIT_WINDOW_MS);
    if (!canProcess) return;

    const levelingConfig = await getLevelingConfig(client, message.guild.id);
    if (!levelingConfig?.enabled) return;
    if (levelingConfig.ignoredChannels?.includes(message.channel.id)) return;

    if (levelingConfig.ignoredRoles?.length > 0) {
      const member = await message.guild.members.fetch(message.author.id).catch(() => null);
      if (member && member.roles.cache.some(role => levelingConfig.ignoredRoles.includes(role.id))) return;
    }

    if (levelingConfig.blacklistedUsers?.includes(message.author.id)) return;
    if (!message.content || message.content.trim().length === 0) return;

    const userData = await getUserLevelData(client, message.guild.id, message.author.id);
    const cooldownTime = levelingConfig.xpCooldown || 60;
    const now = Date.now();
    
    if (now - (userData.lastMessage || 0) < cooldownTime * 1000) return;

    const minXP = Math.max(1, levelingConfig.xpRange?.min || levelingConfig.xpPerMessage?.min || 15);
    const maxXP = Math.max(minXP, levelingConfig.xpRange?.max || levelingConfig.xpPerMessage?.max || 25);

    let finalXP = Math.floor(Math.random() * (maxXP - minXP + 1)) + minXP;
    if (levelingConfig.xpMultiplier && levelingConfig.xpMultiplier > 1) {
      finalXP = Math.floor(finalXP * levelingConfig.xpMultiplier);
    }

    const result = await addXp(client, message.guild, message.member, finalXP);
    if (result.success && result.leveledUp) {
      logger.info(`${message.author.tag} leveled up to level ${result.level} in ${message.guild.name}`);
    }
  } catch (error) {
    logger.error('Error handling leveling for message:', error);
  }
}
    if (!songQuery) return false;

    // استدعاء أمر التشغيل الأساسي
    const command = client.commands.get('play');
    if (!command) return false;

    logger.info(`[FAST PLAY] Bypassing slash command for: ${songQuery}`);

    // 🛡️ التفاعل الوهمي الشامل: يخدع البوت كلياً ليعتقد أنه تفاعل سلاش نظامي
    const mockInteraction = {
        type: 2, 
        id: message.id,
        applicationId: client.user.id,
        isChatInputCommand: () => true,
        isCommand: () => true,
        commandName: 'play',
        options: {
            getSubcommand: () => null,
            getString: () => songQuery, // يرجع اسم الأغنية دائماً
            get: () => ({ value: songQuery }),
            getBoolean: () => null,
            getInteger: () => null,
            getNumber: () => null,
            getUser: () => null,
            getMember: () => null,
            getChannel: () => null,
            getRole: () => null,
            getMentionable: () => null,
            getAttachment: () => null,
        },
        guildId: message.guild.id,
        guild: message.guild,
        channelId: message.channel.id,
        channel: message.channel,
        user: message.author,
        member: message.member,
        client: client,
        deferred: false,
        replied: false,
        deferReply: async () => { mockInteraction.deferred = true; },
        editReply: async (options) => { return await message.channel.send(options).catch(() => {}); },
        reply: async (options) => { 
            mockInteraction.replied = true; 
            return await message.channel.send(options).catch(() => {}); 
        },
        followUp: async (options) => { return await message.channel.send(options).catch(() => {}); },
        fetchReply: async () => message,
        deleteReply: async () => {}
    };

    try {
        await command.execute(mockInteraction, client);
        return true;
    } catch (err) {
        logger.error(`[FAST PLAY ERROR]: ${err.message}`);
        // إرسال رسالة توضح لك سبب الخطأ لو صار
        await message.channel.send(`⚠️ ما قدرت أشغل الأغنية، الخطأ: ${err.message}`).catch(()=>{});
        return true; 
    }
}

async function handlePrefixCommand(message, client) {
  try {
    const guildConfig = await getGuildConfig(client, message.guild.id);
    const prefix = guildConfig?.prefix || client.config.bot.prefix || '!';
    const parsed = parsePrefixCommand(message.content, prefix);
    
    if (!parsed) return; 

    let { commandName, args } = parsed;
    const resolvedCommandName = resolveCommandAlias(commandName);
    const command = client.commands.get(resolvedCommandName);

    if (!command) return; 

    const restriction = getPrefixRestriction(command, args, resolveSubcommandAlias);
    if (!supportsPrefixExecution(command) || restriction.blocked) {
      if (restriction.blocked && restriction.reason) {
        const embed = createEmbed({
          title: 'Slash Command Only',
          description: `${restriction.reason}\nUse \`/${resolvedCommandName}\` instead.`,
          color: 'info',
        });
        await message.channel.send({ embeds: [embed] }).catch(() => {});
      }
      return;
    }

    if (!(await isCommandEnabled(client, message.guild.id, resolvePrefixAccessKey(command.data, args), command.category))) {
      return;
    }

    const mockInteractionForProtection = { guildId: message.guild.id, user: message.author };
    const abuseProtection = await enforceAbuseProtection(mockInteractionForProtection, command, resolvedCommandName);
    
    if (!abuseProtection.allowed) {
      const formattedCooldown = formatCooldownDuration(abuseProtection.remainingMs);
      const embed = createEmbed({
        title: 'Command Cooldown',
        description: `This command is on cooldown. Please wait ${formattedCooldown} before trying again.`,
        color: 'error',
      });
      await message.channel.send({ embeds: [embed] }).catch(() => {});
      return;
    }

    await executePrefixCommand(command, message, args, client, prefix, guildConfig);
  } catch (error) {
    logger.error('Error handling prefix command:', error);
  }
}

async function handleCountingGame(message, client) {
  try {
    const config = await getCountingGameConfig(client, message.guild.id);
    if (!config.enabled || !config.channelId || message.channel.id !== config.channelId) {
      return false;
    }

    const content = message.content.trim();
    const validCount = isValidCountingMessage(content, config);
    const invalidAttempt = !validCount || message.author.id === config.lastUserId;

    if (invalidAttempt) {
      await message.delete().catch(() => {});
      await saveCountingGameConfig(client, message.guild.id, {
        ...config,
        nextNumber: 1,
        lastUserId: null,
        currentStreak: 0,
      });

      const failureMessage = await message.channel.send(`❌ Count broken by <@${message.author.id}>. The sequence has been reset to **1**.`);
      setTimeout(() => { failureMessage.delete().catch(() => {}); }, 10000);
      return true;
    }

    await recordCorrectCount(client, message.guild.id, message.author.id);
    return true;
  } catch (error) {
    logger.error('Error handling counting game:', error);
    return false;
  }
}

async function handleLeveling(message, client) {
  try {
    const rateLimitKey = `xp-event:${message.guild.id}:${message.author.id}`;
    const canProcess = await checkRateLimit(rateLimitKey, MESSAGE_XP_RATE_LIMIT_ATTEMPTS, MESSAGE_XP_RATE_LIMIT_WINDOW_MS);
    if (!canProcess) return;

    const levelingConfig = await getLevelingConfig(client, message.guild.id);
    if (!levelingConfig?.enabled) return;
    if (levelingConfig.ignoredChannels?.includes(message.channel.id)) return;

    if (levelingConfig.ignoredRoles?.length > 0) {
      const member = await message.guild.members.fetch(message.author.id).catch(() => null);
      if (member && member.roles.cache.some(role => levelingConfig.ignoredRoles.includes(role.id))) return;
    }

    if (levelingConfig.blacklistedUsers?.includes(message.author.id)) return;
    if (!message.content || message.content.trim().length === 0) return;

    const userData = await getUserLevelData(client, message.guild.id, message.author.id);
    const cooldownTime = levelingConfig.xpCooldown || 60;
    const now = Date.now();
    
    if (now - (userData.lastMessage || 0) < cooldownTime * 1000) return;

    const minXP = Math.max(1, levelingConfig.xpRange?.min || levelingConfig.xpPerMessage?.min || 15);
    const maxXP = Math.max(minXP, levelingConfig.xpRange?.max || levelingConfig.xpPerMessage?.max || 25);

    let finalXP = Math.floor(Math.random() * (maxXP - minXP + 1)) + minXP;
    if (levelingConfig.xpMultiplier && levelingConfig.xpMultiplier > 1) {
      finalXP = Math.floor(finalXP * levelingConfig.xpMultiplier);
    }

    const result = await addXp(client, message.guild, message.member, finalXP);
    if (result.success && result.leveledUp) {
      logger.info(`${message.author.tag} leveled up to level ${result.level} in ${message.guild.name}`);
    }
  } catch (error) {
    logger.error('Error handling leveling for message:', error);
  }
}
