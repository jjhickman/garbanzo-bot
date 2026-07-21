import type { MessagingAdapter } from './messaging-adapter.js';
import type { MessageRef } from './message-ref.js';
import type { PollPayload } from './poll-payload.js';

export interface DocumentPayload {
  bytes: Uint8Array;
  mimetype: string;
  fileName: string;
}

export interface AudioPayload {
  bytes: Uint8Array;
  mimetype: string;
  ptt?: boolean;
}

/**
 * Platform-agnostic payload for a native calendar event (Discord guild
 * scheduled event, WhatsApp event message). Timestamps are epoch millis.
 */
export interface NativeEventPayload {
  name: string;
  description?: string;
  startAtMs: number;
  endAtMs?: number;
  location?: string;
}

/**
 * Platform messenger interface used by core group handling.
 *
 * It extends the minimal `MessagingAdapter` with the extra send/delete
 * operations that some features rely on (polls, documents, audio, deletes).
 */
export interface PlatformMessenger extends MessagingAdapter {
  sendPoll(chatId: string, poll: PollPayload): Promise<void>;

  /** Returns a platform-specific message ref for optional deletes. */
  sendTextWithRef(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<MessageRef>;

  /** Returns a platform-specific message ref for optional deletes. */
  sendDocument(chatId: string, doc: DocumentPayload): Promise<MessageRef>;

  sendAudio(chatId: string, audio: AudioPayload, options?: { replyTo?: MessageRef }): Promise<void>;

  deleteMessage(chatId: string, messageRef: MessageRef): Promise<void>;

  /**
   * Optional bridge-specific override of `sendText`. Most platforms omit
   * this and the bridge falls back to plain `sendText`. Matrix implements
   * it with a much shorter inline rate-limit-retry budget than its regular
   * `sendText` (2s vs 60s): a bridge relay runs through the outbox's serial
   * drain and the HTTP transport's 10s timeout, so it must throw fast on a
   * rate limit and let the outbox reschedule rather than sleep through a
   * long `retry_after` inside the request. Direct sends (group replies,
   * owner DMs, welcome messages, moderation alerts) have no such deadline
   * and should keep waiting inline up to the homeserver's own retry_after.
   */
  sendTextForBridge?(chatId: string, text: string): Promise<void>;

  /**
   * Optional native-event capability. Platforms without a native event
   * primitive (Telegram, Matrix, Slack) omit these; callers must probe
   * before use and fall back to a "not supported" reply.
   *
   * The returned string is an opaque platform reference (e.g. Discord
   * guild+event ids, or the WhatsApp message key of the latest event
   * message) that the caller persists and hands back on update/cancel.
   * `updateNativeEvent` may return a NEW ref (WhatsApp sends a corrected
   * replacement event message rather than editing in place).
   */
  createNativeEvent?(chatId: string, event: NativeEventPayload): Promise<string>;
  updateNativeEvent?(chatId: string, ref: string, event: NativeEventPayload): Promise<string>;
  cancelNativeEvent?(chatId: string, ref: string, event: NativeEventPayload): Promise<void>;

  /**
   * Optional live interested-user count for a native event (Discord's
   * scheduled-event `user_count`). Platforms that ingest individual RSVPs
   * instead (WhatsApp, into `native_event_rsvps`) omit this. Returns null
   * when the platform reports no count; callers must degrade to showing
   * the event without counts on any error.
   */
  getNativeEventInterestCount?(chatId: string, ref: string): Promise<number | null>;
}
