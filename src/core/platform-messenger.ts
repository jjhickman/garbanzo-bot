import type { MessagingAdapter } from './messaging-adapter.js';

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
  sendPoll(chatId: string, poll: unknown): Promise<void>;

  /** Returns a platform-specific message ref for optional deletes. */
  sendTextWithRef(chatId: string, text: string, options?: { replyTo?: unknown }): Promise<unknown>;

  /** Returns a platform-specific message ref for optional deletes. */
  sendDocument(chatId: string, doc: DocumentPayload): Promise<unknown>;

  sendAudio(chatId: string, audio: AudioPayload, options?: { replyTo?: unknown }): Promise<void>;

  deleteMessage(chatId: string, messageRef: unknown): Promise<void>;
}
