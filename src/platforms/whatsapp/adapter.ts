import type { WASocket, PollMessageOptions } from '@whiskeysockets/baileys';
import type { MessageRef } from '../../core/message-ref.js';
import { createWhatsAppSentMessageRef, getDeleteKey, getQuotedWAMessage } from './message-ref.js';
import type { PollPayload } from '../../core/poll-payload.js';
import type { PlatformMessenger } from '../../core/platform-messenger.js';

export function createWhatsAppAdapter(sock: WASocket): PlatformMessenger {
  return {
    platform: 'whatsapp',

    async sendText(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<void> {
      const quoted = getQuotedWAMessage(options?.replyTo);
      await sock.sendMessage(chatId, { text }, quoted ? { quoted } : undefined);
    },

    async sendTextWithRef(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<MessageRef> {
      const quoted = getQuotedWAMessage(options?.replyTo);
      const sent = await sock.sendMessage(chatId, { text }, quoted ? { quoted } : undefined);
      return createWhatsAppSentMessageRef(chatId, sent);
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
      const sent = await sock.sendMessage(chatId, {
        document: Buffer.from(doc.bytes),
        mimetype: doc.mimetype,
        fileName: doc.fileName,
      });

      return createWhatsAppSentMessageRef(chatId, sent);
    },

    async sendAudio(chatId: string, audio: { bytes: Uint8Array; mimetype: string; ptt?: boolean }, options?: { replyTo?: MessageRef }): Promise<void> {
      const quoted = getQuotedWAMessage(options?.replyTo);

      await sock.sendMessage(chatId, {
        audio: Buffer.from(audio.bytes),
        mimetype: audio.mimetype,
        ptt: audio.ptt ?? true,
      }, quoted ? { quoted } : undefined);
    },

    async deleteMessage(chatId: string, messageRef: MessageRef): Promise<void> {
      const key = getDeleteKey(messageRef);
      if (!key) return;
      await sock.sendMessage(chatId, { delete: key });
    },
  };
}
