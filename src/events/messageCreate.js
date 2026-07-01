import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getGuildConfig } from '../services/guildConfig.js';
import { executePrefixCommand } from '../utils/messageAdapter.js';

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    try {
      if (message.author.bot || !message.guild) return;

      // نظام التشغيل السريع: إذا بدأت الرسالة بـ p متبوعة بمسافة
      if (message.content.toLowerCase().startsWith('p ')) {
        const query = message.content.slice(2).trim();
        if (!query) return;

        // استخراج أمر التشغيل 'play' من قائمة أوامر البوت
        const command = client.commands.get('play');
        if (!command) return;

        logger.info(`[FAST PLAY] Executing song: ${query} for ${message.author.tag}`);

        // إنشاء سياق وهمي لتشغيل الأمر كأنه تم استدعاؤه من خلال النظام
        const mockInteraction = {
          guild: message.guild,
          channel: message.channel,
          user: message.author,
          member: message.member,
          options: {
            getString: () => query,
            getSubcommand: () => 'play'
          },
          reply: async (content) => message.channel.send(content),
          followUp: async (content) => message.channel.send(content),
          deferReply: async () => {}
        };

        // محاولة تنفيذ الأمر مباشرة
        if (command.execute) {
          await command.execute(mockInteraction, client);
        }
        return; // الخروج لمنع تداخل الأوامر الأخرى
      }

      // باقي المنطق الخاص بك (Leveling, Counting, etc.) يوضع هنا إذا كنت تحتاجه
      // تم حذفه مؤقتاً للتركيز على حل مشكلة الميوزك
      
    } catch (error) {
      logger.error('Error in messageCreate event:', error);
    }
  }
};
