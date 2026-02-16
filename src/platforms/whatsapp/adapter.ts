import type { WASocket, WAMessage, PollMessageOptions, WAMessageKey } from '@whiskeysockets/baileys';
import type { MessageRef } from '../../core/message-ref.js';
import type { PollPayload } from '../../core/poll-payload.js';
import type { PlatformMessenger } from '../../core/platform-messenger.js';

export function createWhatsAppAdapter(sock: WASocket): PlatformMessenger {
  return {
    platform: 'whatsapp',

    async sendText(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<void> {
      const replyTo = options?.replyTo?.platform === 'whatsapp'
        ? options.replyTo.ref as WAMessage
        : undefined;

      await sock.sendMessage(chatId, { text }, replyTo ? { quoted: replyTo } : undefined);
    },

    async sendTextWithRef(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<MessageRef> {
      const replyTo = options?.replyTo?.platform === 'whatsapp'
        ? options.replyTo.ref as WAMessage
        : undefined;

      const sent = await sock.sendMessage(chatId, { text }, replyTo ? { quoted: replyTo } : undefined);
      if (!sent) {
        return {
          platform: 'whatsapp',
          chatId,
          id: `wa-sent-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          ref: null,
        };
      }

      return {
        platform: 'whatsapp',
        chatId,
        id: sent.key.id ?? `wa-sent-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        ref: sent,
      };
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

      if (!sent) {
        return {
          platform: 'whatsapp',
          chatId,
          id: `wa-doc-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          ref: null,
        };
      }

      return {
        platform: 'whatsapp',
        chatId,
        id: sent.key.id ?? `wa-doc-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        ref: sent,
      };
    },

    async sendAudio(chatId: string, audio: { bytes: Uint8Array; mimetype: string; ptt?: boolean }, options?: { replyTo?: MessageRef }): Promise<void> {
      const replyTo = options?.replyTo?.platform === 'whatsapp'
        ? options.replyTo.ref as WAMessage
        : undefined;

      await sock.sendMessage(chatId, {
        audio: Buffer.from(audio.bytes),
        mimetype: audio.mimetype,
        ptt: audio.ptt ?? true,
      }, replyTo ? { quoted: replyTo } : undefined);
    },

    async deleteMessage(chatId: string, messageRef: MessageRef): Promise<void> {
      if (messageRef.platform !== 'whatsapp') return;
      if (!messageRef.ref || typeof messageRef.ref !== 'object') return;

      const maybe = messageRef.ref as { key?: unknown };
      if (!maybe.key) return;
      await sock.sendMessage(chatId, { delete: maybe.key as WAMessageKey });
    },
  };
}
