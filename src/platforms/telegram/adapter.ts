import { createMessageRef, type MessageRef } from '../../core/message-ref.js';
import type { PollPayload } from '../../core/poll-payload.js';
import type { PlatformMessenger, DocumentPayload, AudioPayload } from '../../core/platform-messenger.js';
import { logger } from '../../middleware/logger.js';

import { toTelegramMarkdownV2 } from './markdown.js';

const MAX_RETRY_AFTER_MS = 10_000;

interface TelegramApiOkResponse<T> {
  ok: true;
  result: T;
}

interface TelegramApiErrResponse {
  ok: false;
  error_code: number;
  description: string;
  parameters?: { retry_after?: number };
}

type TelegramApiResponse<T> = TelegramApiOkResponse<T> | TelegramApiErrResponse;

export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly errorCode: number,
    public readonly description: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`Telegram API ${method} failed (${errorCode}): ${description}`);
  }
}

function isRetryable429(err: unknown): err is TelegramApiError {
  return err instanceof TelegramApiError && err.errorCode === 429;
}

function isParseEntitiesError(err: unknown): err is TelegramApiError {
  return err instanceof TelegramApiError
    && err.errorCode === 400
    && /can't parse|parse entities|can't find end/i.test(err.description);
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function callTelegramApi<T>(
  token: string,
  method: string,
  body: Record<string, unknown> | FormData,
): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    ...(isForm
      ? { body: body as FormData }
      : { headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) }),
  });

  const json = await response.json() as TelegramApiResponse<T>;
  if (json.ok) return json.result;

  throw new TelegramApiError(method, json.error_code, json.description, json.parameters?.retry_after);
}

/**
 * Single-retry wrapper for Telegram's 429 responses: read `retry_after` and
 * wait once, then retry exactly once — mirrors the Discord relay's
 * single-retry shape (src/bridge/relay-deliver.ts), but lives in the
 * adapter's send path per plan direction so every caller gets the same
 * protection, not just bridge relays.
 */
async function telegramApiRequest<T>(
  token: string,
  method: string,
  body: Record<string, unknown> | FormData,
): Promise<T> {
  try {
    return await callTelegramApi<T>(token, method, body);
  } catch (err) {
    if (!isRetryable429(err)) throw err;

    const waitMs = Math.min((err.retryAfterSeconds ?? 1) * 1000, MAX_RETRY_AFTER_MS);
    logger.warn({ method, waitMs }, 'Telegram 429 — waiting retry_after once before retrying');
    await sleep(waitMs);
    return await callTelegramApi<T>(token, method, body);
  }
}

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

interface TelegramSentMessage {
  message_id: number;
}

export function createTelegramAdapter(token: string): PlatformMessenger {
  async function sendMarkdown(
    chatId: string,
    text: string,
    replyId: number | undefined,
  ): Promise<TelegramSentMessage> {
    const markdown = toTelegramMarkdownV2(text);

    try {
      return await telegramApiRequest<TelegramSentMessage>(token, 'sendMessage', {
        chat_id: chatId,
        text: markdown,
        parse_mode: 'MarkdownV2',
        ...(replyId ? { reply_to_message_id: replyId } : {}),
      });
    } catch (err) {
      if (!isParseEntitiesError(err)) throw err;

      // Fail-soft (plan requirement): our MarkdownV2 translation missed an
      // edge case — retry once as plain text rather than dropping the
      // message outright.
      logger.warn(
        { err: err.message, chatId },
        'Telegram MarkdownV2 parse error — retrying once as plain text',
      );
      return await telegramApiRequest<TelegramSentMessage>(token, 'sendMessage', {
        chat_id: chatId,
        text,
        ...(replyId ? { reply_to_message_id: replyId } : {}),
      });
    }
  }

  return {
    platform: 'telegram',

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
