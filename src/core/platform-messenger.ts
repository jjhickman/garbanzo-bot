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
  sendTextWithRef(chatId: string, text: string, options?: { replyTo?: unknown }): Promise<MessageRef>;

  /** Returns a platform-specific message ref for optional deletes. */
  sendDocument(chatId: string, doc: DocumentPayload): Promise<MessageRef>;

  sendAudio(chatId: string, audio: AudioPayload, options?: { replyTo?: unknown }): Promise<void>;

  deleteMessage(chatId: string, messageRef: MessageRef): Promise<void>;
}
