import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import type { MessagingAdapter } from '../../core/messaging-adapter.js';

export function createWhatsAppAdapter(sock: WASocket): MessagingAdapter {
  return {
    platform: 'whatsapp',
    async sendText(chatId: string, text: string, options?: { replyTo?: unknown }): Promise<void> {
      const replyTo = options?.replyTo as WAMessage | undefined;
      await sock.sendMessage(chatId, { text }, replyTo ? { quoted: replyTo } : undefined);
    },
  };
}
