import { createMessageRef, type MessageRef } from '../../core/message-ref.js';
import type { PollPayload } from '../../core/poll-payload.js';
import type { PlatformMessenger, DocumentPayload, AudioPayload } from '../../core/platform-messenger.js';
import type { SlackTokenProvider } from './token-manager.js';

export interface SlackDemoOutboxEntry {
  type: 'text' | 'poll' | 'document' | 'audio' | 'delete';
  chatId: string;
  payload: unknown;
}

interface SlackApiPostMessageResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

function getThreadIdFromReplyTo(replyTo: MessageRef | undefined): string | null {
  if (!replyTo) return null;
  if (replyTo.platform !== 'slack') return null;
  if (!replyTo.ref || typeof replyTo.ref !== 'object') return null;
  const r = replyTo.ref as Record<string, unknown>;

  const threadId = typeof r.threadId === 'string' ? r.threadId : null;
  if (threadId) return threadId;
  return typeof r.ts === 'string' ? r.ts : null;
}

function getSlackTsFromRef(messageRef: MessageRef): string | null {
  if (messageRef.platform !== 'slack') return null;
  if (!messageRef.ref || typeof messageRef.ref !== 'object') return null;
  const r = messageRef.ref as Record<string, unknown>;
  if (typeof r.ts === 'string') return r.ts;
  if (typeof r.threadId === 'string') return r.threadId;
  return null;
}

function getSlackChannelFromRef(messageRef: MessageRef): string | null {
  if (messageRef.platform !== 'slack') return null;
  if (!messageRef.ref || typeof messageRef.ref !== 'object') return null;
  const r = messageRef.ref as Record<string, unknown>;
  return typeof r.channel === 'string' ? r.channel : null;
}

async function slackApiRequest<T>(
  tokenProvider: SlackTokenProvider,
  endpoint: string,
  init: RequestInit,
): Promise<T> {
  let lastError: string | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await tokenProvider.getToken();
    const response = await fetch(`https://slack.com/api/${endpoint}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });

    const json = await response.json() as T & { ok?: boolean; error?: string };
    const error = typeof json.error === 'string' ? json.error : null;

    if (response.ok && json.ok !== false) {
      return json as T;
    }

    lastError = error ?? `Slack API request failed (${response.status})`;

    const shouldRetryWithRefresh = attempt === 0 && (
      error === 'token_expired'
      || error === 'invalid_auth'
      || error === 'not_authed'
    );

    if (shouldRetryWithRefresh) {
      await tokenProvider.forceRefresh();
      continue;
    }

    break;
  }

  throw new Error(lastError ?? `Slack API request failed: ${endpoint}`);
}

function toSlackRef(chatId: string, ts: string, threadId: string | null): MessageRef {
  return createMessageRef({
    platform: 'slack',
    chatId,
    id: ts,
    ref: {
      kind: 'slack-api',
      ts,
      channel: chatId,
      threadId: threadId ?? ts,
    },
  });
}

export function createSlackAdapter(tokenProvider: SlackTokenProvider): PlatformMessenger {
  return {
    platform: 'slack',

    async sendText(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<void> {
      const threadTs = getThreadIdFromReplyTo(options?.replyTo);

      await slackApiRequest<SlackApiPostMessageResponse>(tokenProvider, 'chat.postMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          channel: chatId,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        }),
      });
    },

    async sendTextWithRef(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<MessageRef> {
      const threadTs = getThreadIdFromReplyTo(options?.replyTo);

      const sent = await slackApiRequest<SlackApiPostMessageResponse>(tokenProvider, 'chat.postMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          channel: chatId,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        }),
      });

      const ts = sent.ts ?? `${Date.now()}`;
      return toSlackRef(chatId, ts, threadTs);
    },

    async sendPoll(chatId: string, poll: PollPayload): Promise<void> {
      const lines = [
        `*${poll.name}*`,
        ...poll.values.map((value, idx) => `${idx + 1}. ${value}`),
        '',
        `Select up to ${poll.selectableCount} option${poll.selectableCount === 1 ? '' : 's'}.`,
      ];

      await slackApiRequest<SlackApiPostMessageResponse>(tokenProvider, 'chat.postMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          channel: chatId,
          text: lines.join('\n'),
        }),
      });
    },

    async sendDocument(chatId: string, doc: DocumentPayload): Promise<MessageRef> {
      const form = new FormData();
      form.set('channels', chatId);
      form.set('filename', doc.fileName);
      form.set('title', doc.fileName);
      form.set('file', new Blob([new Uint8Array(doc.bytes)], { type: doc.mimetype }), doc.fileName);

      const uploaded = await slackApiRequest<{ ok: boolean; file?: { id?: string }; shares?: Record<string, unknown> }>(
        tokenProvider,
        'files.upload',
        {
          method: 'POST',
          body: form,
        },
      );

      const id = uploaded.file?.id ?? `file-${Date.now()}`;
      return createMessageRef({
        platform: 'slack',
        chatId,
        id,
        ref: {
          kind: 'slack-file',
          channel: chatId,
          fileId: id,
        },
      });
    },

    async sendAudio(chatId: string, audio: AudioPayload, options?: { replyTo?: MessageRef }): Promise<void> {
      const form = new FormData();
      form.set('channels', chatId);
      form.set('filename', audio.ptt ? 'voice-note.ogg' : 'audio-message.ogg');
      form.set('title', audio.ptt ? 'Voice Note' : 'Audio Message');
      const threadTs = getThreadIdFromReplyTo(options?.replyTo);
      if (threadTs) form.set('thread_ts', threadTs);
      form.set(
        'file',
        new Blob([new Uint8Array(audio.bytes)], { type: audio.mimetype }),
        audio.ptt ? 'voice-note.ogg' : 'audio-message.ogg',
      );

      await slackApiRequest<{ ok: boolean }>(tokenProvider, 'files.upload', {
        method: 'POST',
        body: form,
      });
    },

    async deleteMessage(chatId: string, messageRef: MessageRef): Promise<void> {
      const ts = getSlackTsFromRef(messageRef);
      const channel = getSlackChannelFromRef(messageRef) ?? chatId;
      if (!ts) return;

      await slackApiRequest<{ ok: boolean }>(tokenProvider, 'chat.delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, ts }),
      });
    },
  };
}

/**
 * A tiny in-process adapter used to exercise core routing without Slack APIs.
 *
 * This is intended for local development only ("demo mode"), not for production.
 */
export function createSlackDemoAdapter(outbox: SlackDemoOutboxEntry[]): PlatformMessenger {
  const nextRef = (chatId: string, threadId: string | null): MessageRef => createMessageRef({
    platform: 'slack',
    chatId,
    id: `slack-demo-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ref: { kind: 'slack-demo', threadId },
  });

  return {
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
}
