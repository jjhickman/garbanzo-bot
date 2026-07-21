/**
 * Minimal Telegram Bot API helper shared by the adapter and the
 * native-event methods. Kept separate from adapter.ts (mirroring
 * discord/api.ts) so both can import it without a cycle. Carries the two
 * cross-cutting behaviors every Telegram call gets:
 *
 * - 429 handling: honor `retry_after` once up to MAX_RETRY_AFTER_MS, throw
 *   immediately beyond it so callers (bridge outbox, etc.) can reschedule
 *   using the real retry_after carried on the error (F5, T2 review).
 * - MarkdownV2 fail-soft: a parse-entities 400 retries once as plain text
 *   instead of dropping the message, counted via recordMarkdownV2Fallback
 *   and logged with a truncated sample (F3, T2 review).
 */

import { logger } from '../../middleware/logger.js';
import { recordMarkdownV2Fallback } from '../../middleware/stats.js';

import { toTelegramMarkdownV2 } from './markdown.js';

// F5 (T2 review): Telegram's documented per-chat/per-group rate limit
// windows run up to a minute; capping the honored `retry_after` at the old
// 10s made the single retry futile for anything past that (we'd wait 10s,
// retry immediately, and get 429'd again since the real window hadn't
// elapsed). Honor the FULL retry_after up to this cap; beyond it, don't
// sleep-and-fail — throw immediately so the caller (bridge outbox, etc.)
// can back off and reschedule using the real retry_after carried on the
// error, rather than the adapter blocking the caller for up to a minute.
const MAX_RETRY_AFTER_MS = 60_000;
const SAMPLE_MAX_CHARS = 80;

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

export interface TelegramSentMessage {
  message_id: number;
}

function isRetryable429(err: unknown): err is TelegramApiError {
  return err instanceof TelegramApiError && err.errorCode === 429;
}

function isParseEntitiesError(err: unknown): err is TelegramApiError {
  return err instanceof TelegramApiError
    && err.errorCode === 400
    && /can't parse|parse entities|can't find end/i.test(err.description);
}

/**
 * `editMessageText` with content identical to the current message is a 400,
 * not a no-op. For our edit-in-place callers that outcome means "already in
 * the desired state", so it is treated as success.
 */
function isMessageNotModifiedError(err: unknown): err is TelegramApiError {
  return err instanceof TelegramApiError
    && err.errorCode === 400
    && /message is not modified/i.test(err.description);
}

/**
 * The edit target no longer exists (or can never be edited): the Bot API
 * answers `editMessageText` on a deleted message with 400 "Bad Request:
 * message to edit not found"; "message can't be edited" and
 * "MESSAGE_ID_INVALID" are the adjacent unrecoverable-target variants.
 * Kept deliberately tight — anything else (parse errors, rights, chat not
 * found) must still surface as a real failure. Callers use this to decide
 * the message is gone for good (e.g. repost an event announcement).
 */
export function isTelegramMessageNotFoundError(err: unknown): err is TelegramApiError {
  return err instanceof TelegramApiError
    && err.errorCode === 400
    && /message to edit not found|message can't be edited|message_id_invalid/i.test(err.description);
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
 * single-retry shape (src/bridge/relay-deliver.ts), but lives in the shared
 * request path so every caller gets the same protection, not just bridge
 * relays.
 *
 * F5 (T2 review): a `retry_after` beyond MAX_RETRY_AFTER_MS is NOT worth a
 * blocking sleep-then-fail — that just makes the caller wait the max cap
 * and still get a 429. Surface it immediately instead; `TelegramApiError`
 * carries `retryAfterSeconds` so callers/outbox can reschedule accurately.
 */
export async function telegramApiRequest<T>(
  token: string,
  method: string,
  body: Record<string, unknown> | FormData,
): Promise<T> {
  try {
    return await callTelegramApi<T>(token, method, body);
  } catch (err) {
    if (!isRetryable429(err)) throw err;

    const retryAfterSeconds = err.retryAfterSeconds ?? 1;
    const waitMs = retryAfterSeconds * 1000;
    if (waitMs > MAX_RETRY_AFTER_MS) {
      logger.warn(
        { method, retryAfterSeconds },
        'Telegram 429 — retry_after exceeds cap, throwing immediately instead of sleep-and-fail',
      );
      throw err;
    }

    logger.warn({ method, waitMs }, 'Telegram 429 — waiting retry_after once before retrying');
    await sleep(waitMs);
    return await callTelegramApi<T>(token, method, body);
  }
}

function logMarkdownFallback(err: TelegramApiError, chatId: string, markdown: string): void {
  // Fail-soft (plan requirement): our MarkdownV2 translation missed an
  // edge case — retry once as plain text rather than dropping the
  // message outright. F3 (T2 review): count the fallback (mirrors
  // recordToolCall's counter idiom) and log a truncated, already-escaped
  // sample of the string that failed to parse so translator gaps are
  // both visible in metrics and diagnosable from the log line alone.
  recordMarkdownV2Fallback('telegram');
  logger.warn(
    { err: err.message, chatId, markdownSample: markdown.slice(0, SAMPLE_MAX_CHARS) },
    'Telegram MarkdownV2 parse error — retrying once as plain text',
  );
}

/** Send `text` (WhatsApp-style markdown) as MarkdownV2, plain-text on parse failure. */
export async function sendTelegramMarkdown(
  token: string,
  chatId: string,
  text: string,
  replyId?: number,
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

    logMarkdownFallback(err, chatId, markdown);
    return await telegramApiRequest<TelegramSentMessage>(token, 'sendMessage', {
      chat_id: chatId,
      text,
      ...(replyId ? { reply_to_message_id: replyId } : {}),
    });
  }
}

/**
 * Edit a previously sent bot message in place (Telegram lets a bot edit its
 * own messages indefinitely), with the same MarkdownV2 fail-soft as sends.
 * An identical-content edit ("message is not modified") counts as success.
 */
export async function editTelegramMarkdown(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
): Promise<void> {
  const markdown = toTelegramMarkdownV2(text);

  try {
    await telegramApiRequest(token, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: markdown,
      parse_mode: 'MarkdownV2',
    });
  } catch (err) {
    if (isMessageNotModifiedError(err)) return;
    if (!isParseEntitiesError(err)) throw err;

    logMarkdownFallback(err, chatId, markdown);
    try {
      await telegramApiRequest(token, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
      });
    } catch (plainErr) {
      if (isMessageNotModifiedError(plainErr)) return;
      throw plainErr;
    }
  }
}
