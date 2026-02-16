import type { MessagingAdapter } from '../../core/messaging-adapter.js';
import { createMessageRef, type MessageRef } from '../../core/message-ref.js';
import type { PollPayload } from '../../core/poll-payload.js';
import type { PlatformMessenger, DocumentPayload, AudioPayload } from '../../core/platform-messenger.js';

export interface DiscordDemoOutboxEntry {
  type: 'text' | 'poll' | 'document' | 'audio' | 'delete';
  chatId: string;
  payload: unknown;
}

function getThreadIdFromReplyTo(replyTo: MessageRef | undefined): string | null {
  if (!replyTo) return null;
  if (replyTo.platform !== 'discord') return null;
  if (!replyTo.ref || typeof replyTo.ref !== 'object') return null;
  const r = replyTo.ref as Record<string, unknown>;
  return typeof r.threadId === 'string' ? r.threadId : null;
}

export function createDiscordAdapter(): PlatformMessenger {
  const err = () => new Error('Discord platform is not implemented');

  const adapter: PlatformMessenger = {
    platform: 'discord',

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

  void (adapter satisfies MessagingAdapter);

  return adapter;
}

export function createDiscordDemoAdapter(outbox: DiscordDemoOutboxEntry[]): PlatformMessenger {
  const nextRef = (chatId: string, threadId: string | null): MessageRef => createMessageRef({
    platform: 'discord',
    chatId,
    id: `discord-demo-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ref: { kind: 'discord-demo', threadId },
  });

  const adapter: PlatformMessenger = {
    platform: 'discord',

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
      outbox.push({ type: 'poll', chatId, payload: poll });
    },

    async sendTextWithRef(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<MessageRef> {
      const threadId = getThreadIdFromReplyTo(options?.replyTo);
      const ref = nextRef(chatId, threadId);
      outbox.push({
        type: 'text',
        chatId,
        payload: {
          text,
          replyToId: options?.replyTo?.id ?? null,
          threadId,
          ref,
        },
      });
      return ref;
    },

    async sendDocument(chatId: string, doc: DocumentPayload): Promise<MessageRef> {
      const ref = nextRef(chatId, null);
      outbox.push({
        type: 'document',
        chatId,
        payload: {
          fileName: doc.fileName,
          mimetype: doc.mimetype,
          bytesLength: doc.bytes.length,
          ref,
        },
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
      outbox.push({ type: 'delete', chatId, payload: { messageRef } });
    },
  };

  void (adapter satisfies MessagingAdapter);

  return adapter;
}
