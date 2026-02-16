import type { MessagingAdapter } from '../../core/messaging-adapter.js';
import { createMessageRef, type MessageRef } from '../../core/message-ref.js';
import type { PollPayload } from '../../core/poll-payload.js';
import type { PlatformMessenger, DocumentPayload, AudioPayload } from '../../core/platform-messenger.js';

/**
 * Slack adapter skeleton.
 *
 * This intentionally throws for all operations until the Slack runtime is implemented.
 * It exists to validate the platform/core boundaries at compile-time.
 */
export interface SlackDemoOutboxEntry {
  type: 'text' | 'poll' | 'document' | 'audio' | 'delete';
  chatId: string;
  payload: unknown;
}

function getThreadIdFromReplyTo(replyTo: MessageRef | undefined): string | null {
  if (!replyTo) return null;
  if (replyTo.platform !== 'slack') return null;
  if (!replyTo.ref || typeof replyTo.ref !== 'object') return null;
  const r = replyTo.ref as Record<string, unknown>;
  return typeof r.threadId === 'string' ? r.threadId : null;
}

export function createSlackAdapter(): PlatformMessenger {
  const err = () => new Error('Slack platform is not implemented');

  const adapter: PlatformMessenger = {
    platform: 'slack',

    async sendText(): Promise<void> {
      throw err();
    },

    async sendPoll(_chatId: string, _poll: PollPayload): Promise<void> {
      throw err();
    },

    async sendTextWithRef(): Promise<MessageRef> {
      throw err();
    },

    async sendDocument(_chatId: string, _doc: DocumentPayload): Promise<MessageRef> {
      throw err();
    },

    async sendAudio(_chatId: string, _audio: AudioPayload): Promise<void> {
      throw err();
    },

    async deleteMessage(): Promise<void> {
      throw err();
    },
  };

  // Ensure we still satisfy the minimal MessagingAdapter contract
  void (adapter satisfies MessagingAdapter);

  return adapter;
}

/**
 * A tiny in-process adapter used to exercise core routing without Slack APIs.
 *
 * This is intended for local development only ("demo mode"), not for production.
 */
export function createSlackDemoAdapter(outbox: SlackDemoOutboxEntry[]): PlatformMessenger {
  const nextRef = (chatId: string): MessageRef => createMessageRef({
    platform: 'slack',
    chatId,
    id: `slack-demo-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ref: { kind: 'slack-demo' },
  });

  const adapter: PlatformMessenger = {
    platform: 'slack',

    async sendText(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<void> {
      outbox.push({
        type: 'text',
        chatId,
        payload: {
          text,
          replyToId: options?.replyTo?.id ?? null,
          threadId: getThreadIdFromReplyTo(options?.replyTo),
        },
      });
    },

    async sendPoll(chatId: string, poll: PollPayload): Promise<void> {
      outbox.push({
        type: 'poll',
        chatId,
        payload: poll,
      });
    },

    async sendTextWithRef(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<MessageRef> {
      const ref = nextRef(chatId);
      outbox.push({
        type: 'text',
        chatId,
        payload: {
          text,
          replyToId: options?.replyTo?.id ?? null,
          threadId: getThreadIdFromReplyTo(options?.replyTo),
          ref,
        },
      });
      return ref;
    },

    async sendDocument(chatId: string, doc: DocumentPayload): Promise<MessageRef> {
      const ref = nextRef(chatId);
      outbox.push({
        type: 'document',
        chatId,
        payload: { fileName: doc.fileName, mimetype: doc.mimetype, bytesLength: doc.bytes.length, ref },
      });
      return ref;
    },

    async sendAudio(chatId: string, audio: AudioPayload, options?: { replyTo?: MessageRef }): Promise<void> {
      outbox.push({
        type: 'audio',
        chatId,
        payload: {
          mimetype: audio.mimetype,
          ptt: audio.ptt ?? false,
          bytesLength: audio.bytes.length,
          replyToId: options?.replyTo?.id ?? null,
          threadId: getThreadIdFromReplyTo(options?.replyTo),
        },
      });
    },

    async deleteMessage(chatId: string, messageRef: MessageRef): Promise<void> {
      outbox.push({
        type: 'delete',
        chatId,
        payload: { messageRef },
      });
    },
  };

  void (adapter satisfies MessagingAdapter);

  return adapter;
}
