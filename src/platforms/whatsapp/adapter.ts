import type { WASocket, WAMessage, PollMessageOptions, WAMessageKey } from '@whiskeysockets/baileys';
import type { MessageRef } from '../../core/message-ref.js';
import type { PollPayload } from '../../core/poll-payload.js';
import type { PlatformMessenger } from '../../core/platform-messenger.js';

export function createWhatsAppAdapter(sock: WASocket): PlatformMessenger {
  return {
    platform: 'whatsapp',

    async sendText(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<void> {
      const replyTo = options?.replyTo as WAMessage | undefined;
      await sock.sendMessage(chatId, { text }, replyTo ? { quoted: replyTo } : undefined);
    },

    async sendTextWithRef(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<MessageRef> {
      const replyTo = options?.replyTo as WAMessage | undefined;
      return await sock.sendMessage(chatId, { text }, replyTo ? { quoted: replyTo } : undefined);
    },

    async sendPoll(chatId: string, poll: PollPayload): Promise<void> {
      // Map the core poll payload into the Baileys poll message shape.
      const payload: PollMessageOptions = {
        name: poll.name,
        values: poll.values,
        selectableCount: poll.selectableCount,
      };

      await sock.sendMessage(chatId, { poll: payload });
    },

    async sendDocument(chatId: string, doc: { bytes: Uint8Array; mimetype: string; fileName: string }): Promise<MessageRef> {
      return await sock.sendMessage(chatId, {
        document: Buffer.from(doc.bytes),
        mimetype: doc.mimetype,
        fileName: doc.fileName,
      });
    },

    async sendAudio(chatId: string, audio: { bytes: Uint8Array; mimetype: string; ptt?: boolean }, options?: { replyTo?: MessageRef }): Promise<void> {
      const replyTo = options?.replyTo as WAMessage | undefined;
      await sock.sendMessage(chatId, {
        audio: Buffer.from(audio.bytes),
        mimetype: audio.mimetype,
        ptt: audio.ptt ?? true,
      }, replyTo ? { quoted: replyTo } : undefined);
    },

    async deleteMessage(chatId: string, messageRef: MessageRef): Promise<void> {
      if (!messageRef || typeof messageRef !== 'object') return;
      const maybe = messageRef as { key?: unknown };
      if (!maybe.key) return;
      await sock.sendMessage(chatId, { delete: maybe.key as WAMessageKey });
    },
  };
}
