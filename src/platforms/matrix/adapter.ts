import { createMessageRef, type MessageRef } from '../../core/message-ref.js';
import type { AudioPayload, DocumentPayload, PlatformMessenger } from '../../core/platform-messenger.js';
import type { PollPayload } from '../../core/poll-payload.js';
import { logger } from '../../middleware/logger.js';

import { toMatrixMessageContent } from './markdown.js';
import { createMatrixNativeEventMethods } from './native-events.js';

const MAX_RETRY_AFTER_MS = 60_000;

export interface MatrixSendClient {
  sendMessage(roomId: string, content: Record<string, unknown>): Promise<string | { event_id?: string }>;
  uploadContent?(bytes: Uint8Array, mimetype?: string, fileName?: string): Promise<string>;
  redactEvent?(roomId: string, eventId: string, reason?: string): Promise<void>;
}

export class MatrixRateLimitError extends Error {
  constructor(
    public readonly method: string,
    public readonly retryAfterMs: number,
    message = `Matrix ${method} was rate limited`,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function getNestedRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function getNumeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getRetryAfterHeaderMs(source: Record<string, unknown> | undefined): number | undefined {
  const headers = source ? getNestedRecord(source, 'headers') : undefined;
  if (!headers) return undefined;
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  const seconds = typeof raw === 'string' ? Number(raw) : getNumeric(raw);
  return seconds !== undefined && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function getRetryAfterMs(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined;

  const body = getNestedRecord(err, 'body') ?? getNestedRecord(err, 'data') ?? getNestedRecord(err, 'response');
  const errcode = err.errcode ?? body?.errcode;
  const status = err.statusCode ?? err.status ?? body?.statusCode ?? body?.status;
  const retryAfterMs = getNumeric(err.retryAfterMs)
    ?? getNumeric(err.retry_after_ms)
    ?? getNumeric(body?.retry_after_ms)
    ?? getNumeric(body?.retryAfterMs)
    // Some homeservers/proxies only send a Retry-After header (seconds)
    ?? getRetryAfterHeaderMs(err)
    ?? getRetryAfterHeaderMs(body);

  if (errcode === 'M_LIMIT_EXCEEDED' || status === 429) {
    return retryAfterMs ?? 1000;
  }

  return undefined;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Longest wait we tolerate INSIDE a DIRECT (interactive) call — group
 * replies, owner DMs, welcome messages, moderation alerts. This matches the
 * cap on the thrown error (MAX_RETRY_AFTER_MS) so a direct send only ever
 * throws when the homeserver's own retry_after is unreasonable, restoring
 * the original sleep-and-deliver behavior for the common case of a normal
 * M_LIMIT_EXCEEDED wait.
 */
const DIRECT_INLINE_RETRY_MAX_MS = MAX_RETRY_AFTER_MS;

/**
 * Longest wait we tolerate INSIDE a BRIDGE delivery call. Bridge deliveries
 * run through the outbox's serial drain and the HTTP transport's 10s
 * timeout, so anything longer than this must throw MatrixRateLimitError for
 * the caller (the bridge outbox) to convert into a scheduled deferral
 * instead of a blocked request sleeping through it. See
 * sendMatrixTextForBridge below — this is intentionally far smaller than
 * DIRECT_INLINE_RETRY_MAX_MS.
 */
const BRIDGE_INLINE_RETRY_MAX_MS = 2_000;

async function matrixClientRequest<T>(
  method: string,
  action: () => Promise<T>,
  maxInlineWaitMs: number = DIRECT_INLINE_RETRY_MAX_MS,
): Promise<T> {
  try {
    return await action();
  } catch (err) {
    const retryAfterMs = getRetryAfterMs(err);
    if (retryAfterMs === undefined) throw err;

    if (retryAfterMs > maxInlineWaitMs) {
      logger.warn(
        { method, retryAfterMs, maxInlineWaitMs },
        'Matrix 429 — retry_after exceeds the inline wait budget, throwing for the caller to schedule',
      );
      throw new MatrixRateLimitError(method, Math.min(retryAfterMs, MAX_RETRY_AFTER_MS));
    }

    logger.warn({ method, retryAfterMs }, 'Matrix 429 — waiting retry_after once before retrying');
    await sleep(retryAfterMs);
    return await action();
  }
}

function getReplyEventId(replyTo: MessageRef | undefined): string | undefined {
  if (!replyTo || replyTo.platform !== 'matrix') return undefined;
  return replyTo.id;
}

function toMatrixRef(roomId: string, eventId: string): MessageRef {
  return createMessageRef({
    platform: 'matrix',
    chatId: roomId,
    id: eventId,
    ref: { kind: 'matrix-event', roomId, eventId },
  });
}

function getEventId(sent: string | { event_id?: string }): string {
  return typeof sent === 'string' ? sent : sent.event_id ?? '';
}

/**
 * Bridge-only text send: identical content shape to `sendText`, but bounded
 * by BRIDGE_INLINE_RETRY_MAX_MS instead of the direct-send budget, so a slow
 * homeserver rate limit throws MatrixRateLimitError for the bridge outbox to
 * defer instead of blocking its serial drain. Takes the raw MatrixSendClient
 * (not a PlatformMessenger) so it can be called with just the same client
 * the adapter itself closes over — createMatrixAdapter's returned
 * `sendTextForBridge` is a thin wrapper around this for callers that only
 * have the adapter/messenger in hand.
 */
export async function sendMatrixTextForBridge(client: MatrixSendClient, roomId: string, text: string): Promise<void> {
  const content = toMatrixMessageContent(roomId, text);
  await matrixClientRequest('sendMessage', () => client.sendMessage(roomId, content), BRIDGE_INLINE_RETRY_MAX_MS);
}

export function createMatrixAdapter(client: MatrixSendClient): PlatformMessenger {
  async function sendContent(roomId: string, content: Record<string, unknown>): Promise<MessageRef> {
    const sent = await matrixClientRequest('sendMessage', () => client.sendMessage(roomId, content));
    const eventId = getEventId(sent);
    return toMatrixRef(roomId, eventId);
  }

  // Native events are announcement messages edited in place via m.replace
  // (see native-events.ts); they share the direct-send rate-limit budget.
  const nativeEvents = createMatrixNativeEventMethods(
    client,
    (method, action) => matrixClientRequest(method, action),
  );

  return {
    platform: 'matrix',

    createNativeEvent: nativeEvents.createNativeEvent,
    updateNativeEvent: nativeEvents.updateNativeEvent,
    cancelNativeEvent: nativeEvents.cancelNativeEvent,

    async sendText(roomId: string, text: string, options?: { replyTo?: MessageRef }): Promise<void> {
      await sendContent(roomId, toMatrixMessageContent(roomId, text, getReplyEventId(options?.replyTo)));
    },

    async sendTextForBridge(roomId: string, text: string): Promise<void> {
      await sendMatrixTextForBridge(client, roomId, text);
    },

    async sendTextWithRef(roomId: string, text: string, options?: { replyTo?: MessageRef }): Promise<MessageRef> {
      return sendContent(roomId, toMatrixMessageContent(roomId, text, getReplyEventId(options?.replyTo)));
    },

    async sendPoll(roomId: string, poll: PollPayload): Promise<void> {
      const lines = [
        `*${poll.name}*`,
        ...poll.values.map((value, idx) => `${idx + 1}. ${value}`),
        '',
        `Select up to ${poll.selectableCount} option${poll.selectableCount === 1 ? '' : 's'}.`,
      ];
      await sendContent(roomId, toMatrixMessageContent(roomId, lines.join('\n')));
    },

    async sendDocument(roomId: string, doc: DocumentPayload): Promise<MessageRef> {
      const uploadContent = client.uploadContent;
      if (!uploadContent) {
        throw new Error('Matrix document send requires uploadContent support');
      }
      const url = await matrixClientRequest('uploadContent', () => uploadContent(
        doc.bytes,
        doc.mimetype,
        doc.fileName,
      ));
      return sendContent(roomId, {
        msgtype: 'm.file',
        body: doc.fileName,
        url,
        info: { mimetype: doc.mimetype },
      });
    },

    async sendAudio(roomId: string, audio: AudioPayload, options?: { replyTo?: MessageRef }): Promise<void> {
      const uploadContent = client.uploadContent;
      if (!uploadContent) {
        throw new Error('Matrix audio send requires uploadContent support');
      }
      const url = await matrixClientRequest('uploadContent', () => uploadContent(
        audio.bytes,
        audio.mimetype,
        audio.ptt ? 'voice-note.ogg' : 'audio-message.ogg',
      ));
      await sendContent(roomId, {
        msgtype: 'm.audio',
        body: audio.ptt ? 'voice note' : 'audio message',
        url,
        info: { mimetype: audio.mimetype },
        ...(getReplyEventId(options?.replyTo)
          ? { 'm.relates_to': { 'm.in_reply_to': { event_id: getReplyEventId(options?.replyTo) } } }
          : {}),
      });
    },

    async deleteMessage(roomId: string, messageRef: MessageRef): Promise<void> {
      const redactEvent = client.redactEvent;
      if (!redactEvent || messageRef.platform !== 'matrix') return;
      await matrixClientRequest('redactEvent', () => redactEvent(roomId, messageRef.id, 'deleted by bot'));
    },
  };
}
