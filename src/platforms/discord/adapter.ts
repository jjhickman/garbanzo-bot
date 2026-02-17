import { createMessageRef, type MessageRef } from '../../core/message-ref.js';
import type { PollPayload } from '../../core/poll-payload.js';
import type { PlatformMessenger, DocumentPayload, AudioPayload } from '../../core/platform-messenger.js';

export interface DiscordDemoOutboxEntry {
  type: 'text' | 'poll' | 'document' | 'audio' | 'delete';
  chatId: string;
  payload: unknown;
}

interface DiscordCreateMessageResponse {
  id: string;
  channel_id: string;
}

function getReplyMessageId(replyTo: MessageRef | undefined): string | null {
  if (!replyTo) return null;
  if (replyTo.platform !== 'discord') return null;
  return replyTo.id ?? null;
}

function getChannelFromMessageRef(ref: MessageRef): string | null {
  if (ref.platform !== 'discord') return null;
  if (!ref.ref || typeof ref.ref !== 'object') return null;
  const value = ref.ref as Record<string, unknown>;
  return typeof value.channelId === 'string' ? value.channelId : ref.chatId;
}

async function discordApiRequest<T>(
  token: string,
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: {
      authorization: `Bot ${token}`,
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord API ${path} failed (${response.status}): ${text}`);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return await response.json() as T;
}

function toDiscordRef(chatId: string, messageId: string): MessageRef {
  return createMessageRef({
    platform: 'discord',
    chatId,
    id: messageId,
    ref: {
      kind: 'discord-api',
      channelId: chatId,
      messageId,
      threadId: null,
    },
  });
}

export function createDiscordAdapter(token: string): PlatformMessenger {
  return {
    platform: 'discord',

    async sendText(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<void> {
      const replyId = getReplyMessageId(options?.replyTo);

      await discordApiRequest<DiscordCreateMessageResponse>(token, `/channels/${chatId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          content: text,
          ...(replyId ? { message_reference: { message_id: replyId } } : {}),
        }),
      });
    },

    async sendTextWithRef(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<MessageRef> {
      const replyId = getReplyMessageId(options?.replyTo);

      const sent = await discordApiRequest<DiscordCreateMessageResponse>(token, `/channels/${chatId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          content: text,
          ...(replyId ? { message_reference: { message_id: replyId } } : {}),
        }),
      });

      return toDiscordRef(chatId, sent.id);
    },

    async sendPoll(chatId: string, poll: PollPayload): Promise<void> {
      const lines = [
        `**${poll.name}**`,
        ...poll.values.map((value, idx) => `${idx + 1}. ${value}`),
        '',
        `Select up to ${poll.selectableCount} option${poll.selectableCount === 1 ? '' : 's'}.`,
      ];

      await discordApiRequest<DiscordCreateMessageResponse>(token, `/channels/${chatId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ content: lines.join('\n') }),
      });
    },

    async sendDocument(chatId: string, doc: DocumentPayload): Promise<MessageRef> {
      const form = new FormData();
      form.set('payload_json', JSON.stringify({ content: '' }));
      form.set('files[0]', new Blob([new Uint8Array(doc.bytes)], { type: doc.mimetype }), doc.fileName);

      const sent = await discordApiRequest<DiscordCreateMessageResponse>(token, `/channels/${chatId}/messages`, {
        method: 'POST',
        body: form,
      });

      return toDiscordRef(chatId, sent.id);
    },

    async sendAudio(chatId: string, audio: AudioPayload, options?: { replyTo?: MessageRef }): Promise<void> {
      const replyId = getReplyMessageId(options?.replyTo);
      const form = new FormData();
      form.set('payload_json', JSON.stringify({
        content: audio.ptt ? 'Voice note' : 'Audio message',
        ...(replyId ? { message_reference: { message_id: replyId } } : {}),
      }));
      form.set(
        'files[0]',
        new Blob([new Uint8Array(audio.bytes)], { type: audio.mimetype }),
        audio.ptt ? 'voice-note.ogg' : 'audio-message.ogg',
      );

      await discordApiRequest<DiscordCreateMessageResponse>(token, `/channels/${chatId}/messages`, {
        method: 'POST',
        body: form,
      });
    },

    async deleteMessage(chatId: string, messageRef: MessageRef): Promise<void> {
      const channelId = getChannelFromMessageRef(messageRef) ?? chatId;
      if (!messageRef.id) return;

      await discordApiRequest<Record<string, never>>(
        token,
        `/channels/${channelId}/messages/${messageRef.id}`,
        { method: 'DELETE' },
      );
    },
  };
}

function getThreadIdFromReplyTo(replyTo: MessageRef | undefined): string | null {
  if (!replyTo) return null;
  if (replyTo.platform !== 'discord') return null;
  if (!replyTo.ref || typeof replyTo.ref !== 'object') return null;
  const r = replyTo.ref as Record<string, unknown>;
  return typeof r.threadId === 'string' ? r.threadId : null;
}

export function createDiscordDemoAdapter(outbox: DiscordDemoOutboxEntry[]): PlatformMessenger {
  const nextRef = (chatId: string, threadId: string | null): MessageRef => createMessageRef({
    platform: 'discord',
    chatId,
    id: `discord-demo-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ref: { kind: 'discord-demo', threadId },
  });

  return {
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
}
