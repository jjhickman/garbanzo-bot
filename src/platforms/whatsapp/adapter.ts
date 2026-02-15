import type { WASocket, WAMessage, PollMessageOptions, WAMessageKey } from '@whiskeysockets/baileys';
import type { PlatformMessenger } from '../../core/platform-messenger.js';

export function createWhatsAppAdapter(sock: WASocket): PlatformMessenger {
  return {
    platform: 'whatsapp',

    async sendText(chatId: string, text: string, options?: { replyTo?: unknown }): Promise<void> {
      const replyTo = options?.replyTo as WAMessage | undefined;
      await sock.sendMessage(chatId, { text }, replyTo ? { quoted: replyTo } : undefined);
    },

    async sendTextWithRef(chatId: string, text: string, options?: { replyTo?: unknown }): Promise<unknown> {
      const replyTo = options?.replyTo as WAMessage | undefined;
      return await sock.sendMessage(chatId, { text }, replyTo ? { quoted: replyTo } : undefined);
    },

    async sendPoll(chatId: string, poll: unknown): Promise<void> {
      // Accept the core's opaque poll object and assert to Baileys poll payload.
      await sock.sendMessage(chatId, { poll: poll as PollMessageOptions });
    },

    async sendDocument(chatId: string, doc: { bytes: Uint8Array; mimetype: string; fileName: string }): Promise<unknown> {
      return await sock.sendMessage(chatId, {
        document: Buffer.from(doc.bytes),
        mimetype: doc.mimetype,
        fileName: doc.fileName,
      });
    },

    async sendAudio(chatId: string, audio: { bytes: Uint8Array; mimetype: string; ptt?: boolean }, options?: { replyTo?: unknown }): Promise<void> {
      const replyTo = options?.replyTo as WAMessage | undefined;
      await sock.sendMessage(chatId, {
        audio: Buffer.from(audio.bytes),
        mimetype: audio.mimetype,
        ptt: audio.ptt ?? true,
      }, replyTo ? { quoted: replyTo } : undefined);
    },

    async deleteMessage(chatId: string, messageRef: unknown): Promise<void> {
      if (!messageRef || typeof messageRef !== 'object') return;
      const maybe = messageRef as { key?: unknown };
      if (!maybe.key) return;
      await sock.sendMessage(chatId, { delete: maybe.key as WAMessageKey });
    },
  };
}
