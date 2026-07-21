import { createMessageRef, type MessageRef } from '../../core/message-ref.js';
import type { PollPayload } from '../../core/poll-payload.js';
import type { PlatformMessenger, DocumentPayload, AudioPayload } from '../../core/platform-messenger.js';

import { sendTelegramMarkdown, telegramApiRequest, type TelegramSentMessage } from './api.js';
import { createTelegramNativeEventMethods } from './native-events.js';

// The shared request/markdown plumbing (429 handling, MarkdownV2 fail-soft)
// lives in api.ts so native-events.ts can import it without a cycle;
// TelegramApiError is re-exported here for existing callers/tests.
export { TelegramApiError } from './api.js';

function getReplyMessageId(replyTo: MessageRef | undefined): number | undefined {
  if (!replyTo) return undefined;
  if (replyTo.platform !== 'telegram') return undefined;
  const id = Number(replyTo.id);
  return Number.isFinite(id) ? id : undefined;
}

function toTelegramRef(chatId: string, messageId: number): MessageRef {
  return createMessageRef({
    platform: 'telegram',
    chatId,
    id: String(messageId),
    ref: { kind: 'telegram-api', chatId, messageId },
  });
}

export function createTelegramAdapter(token: string): PlatformMessenger {
  async function sendMarkdown(
    chatId: string,
    text: string,
    replyId: number | undefined,
  ): Promise<TelegramSentMessage> {
    return sendTelegramMarkdown(token, chatId, text, replyId);
  }

  const nativeEvents = createTelegramNativeEventMethods(token);

  return {
    platform: 'telegram',

    createNativeEvent: nativeEvents.createNativeEvent,
    updateNativeEvent: nativeEvents.updateNativeEvent,
    cancelNativeEvent: nativeEvents.cancelNativeEvent,

    async sendText(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<void> {
      await sendMarkdown(chatId, text, getReplyMessageId(options?.replyTo));
    },

    async sendTextWithRef(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<MessageRef> {
      const sent = await sendMarkdown(chatId, text, getReplyMessageId(options?.replyTo));
      return toTelegramRef(chatId, sent.message_id);
    },

    async sendPoll(chatId: string, poll: PollPayload): Promise<void> {
      // Text-list fallback (matches the Discord/Slack adapters) rather than
      // Telegram's native poll type — keeps semantics (selectableCount,
      // arbitrary option count) identical across platforms.
      const lines = [
        `*${poll.name}*`,
        ...poll.values.map((value, idx) => `${idx + 1}. ${value}`),
        '',
        `Select up to ${poll.selectableCount} option${poll.selectableCount === 1 ? '' : 's'}.`,
      ];

      await sendMarkdown(chatId, lines.join('\n'), undefined);
    },

    async sendDocument(chatId: string, doc: DocumentPayload): Promise<MessageRef> {
      const form = new FormData();
      form.set('chat_id', chatId);
      form.set('document', new Blob([new Uint8Array(doc.bytes)], { type: doc.mimetype }), doc.fileName);

      const sent = await telegramApiRequest<TelegramSentMessage>(token, 'sendDocument', form);
      return toTelegramRef(chatId, sent.message_id);
    },

    async sendAudio(chatId: string, audio: AudioPayload, options?: { replyTo?: MessageRef }): Promise<void> {
      const replyId = getReplyMessageId(options?.replyTo);
      const form = new FormData();
      form.set('chat_id', chatId);
      if (replyId) form.set('reply_to_message_id', String(replyId));

      // Telegram distinguishes a "voice note" bubble (sendVoice, ogg/opus)
      // from a regular audio file (sendAudio) — mirrors Discord's ptt flag.
      const field = audio.ptt ? 'voice' : 'audio';
      const fileName = audio.ptt ? 'voice-note.ogg' : 'audio-message.ogg';
      form.set(field, new Blob([new Uint8Array(audio.bytes)], { type: audio.mimetype }), fileName);

      await telegramApiRequest<TelegramSentMessage>(token, audio.ptt ? 'sendVoice' : 'sendAudio', form);
    },

    async deleteMessage(chatId: string, messageRef: MessageRef): Promise<void> {
      const id = getReplyMessageId(messageRef);
      if (!id) return;

      await telegramApiRequest<boolean>(token, 'deleteMessage', {
        chat_id: chatId,
        message_id: id,
      });
    },
  };
}
