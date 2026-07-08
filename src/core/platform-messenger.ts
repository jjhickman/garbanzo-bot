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
}
