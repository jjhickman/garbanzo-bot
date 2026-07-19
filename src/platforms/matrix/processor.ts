import { z } from 'zod';

import { captureForBridge } from '../../bridge/capture-hook.js';
import { createMessageRef } from '../../core/message-ref.js';
import { processGroupMessage } from '../../core/process-group-message.js';
import { processInboundMessage } from '../../core/process-inbound-message.js';
import type { PlatformMessenger } from '../../core/platform-messenger.js';
import { getResponse } from '../../core/response-router.js';
import { transcribeAudio } from '../../features/voice.js';
import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';

import type { MatrixInbound } from './inbound.js';
import {
  getMatrixRoomName,
  isMatrixFeatureEnabled,
  isMatrixRoomEnabled,
  matrixRoomRequiresMention,
} from './matrix-config.js';

// Shared with telegram/processor.ts and the bridge's own media-placeholder
// text (src/bridge/relay-capture.ts uses the same literal) — a single
// source of truth for the placeholder string, and the flag below (not text
// equality) is what tells the core dispatch-skip gate to stay quiet.
import { VOICE_NOTE_PLACEHOLDER } from '../../core/inbound-message.js';

const MatrixAudioSchema = z.object({
  url: z.string(),
  contentType: z.string(),
  buffer: z.instanceof(Buffer).optional(),
});

const MatrixMediaSchema = z.object({
  url: z.string().optional(),
  contentType: z.string(),
  fileName: z.string().optional(),
  buffer: z.instanceof(Buffer).optional(),
  kind: z.enum(['image', 'video', 'document']),
});

const MatrixEventSchema = z.object({
  messageId: z.string(),
  roomId: z.string(),
  isGroupChat: z.boolean(),
  text: z.string().default(''),
  senderId: z.string(),
  senderName: z.string().optional(),
  timestampMs: z.number(),
  quotedText: z.string().optional(),
  fromSelf: z.boolean().default(false),
  mentionedIds: z.array(z.string()).optional(),
  audio: MatrixAudioSchema.optional(),
  media: MatrixMediaSchema.optional(),
});

type MatrixEvent = z.infer<typeof MatrixEventSchema>;
type MatrixRoomEnabled = (roomId: string) => boolean;

function normalizeMatrixInbound(event: MatrixEvent): MatrixInbound {
  return {
    platform: 'matrix',
    chatId: event.roomId,
    chatName: getMatrixRoomName(event.roomId),
    senderId: event.senderId,
    senderName: event.senderName,
    messageId: event.messageId,
    fromSelf: event.fromSelf,
    isStatusBroadcast: false,
    isGroupChat: event.isGroupChat,
    timestampMs: event.timestampMs,
    text: event.text,
    quotedText: event.quotedText,
    mentionedIds: event.mentionedIds,
    hasVisualMedia: Boolean(event.media),
    audio: event.audio,
    media: event.media,
    raw: createMessageRef({
      platform: 'matrix',
      chatId: event.roomId,
      id: event.messageId,
      ref: {
        kind: 'matrix-inbound',
        roomId: event.roomId,
        eventId: event.messageId,
      },
    }),
  };
}

/**
 * Mirrors telegram/processor.ts's resolveVoiceText: a captionless voice
 * message that fails to download or transcribe falls back to the
 * VOICE_NOTE_PLACEHOLDER text so moderation, capture, and bridging still see
 * SOMETHING rather than silence — but `synthesized: true` tells the caller
 * to set `inbound.synthesizedPlaceholder`, which is what actually makes the
 * core dispatch-skip gate (process-inbound-message.ts) stay quiet. Without
 * that flag, the message reaches handleGroupMessage/handleOwnerDM like any
 * normal text message and the bot replies to its own placeholder.
 */
async function resolveAudioText(event: MatrixEvent): Promise<{ text: string; synthesized: boolean }> {
  if (event.text || !event.audio) return { text: event.text, synthesized: false };

  if (!event.audio.buffer) {
    logger.debug('Matrix audio message download unavailable — using placeholder');
    return { text: VOICE_NOTE_PLACEHOLDER, synthesized: true };
  }

  const transcript = await transcribeAudio(event.audio.buffer, event.audio.contentType);
  if (!transcript) {
    logger.debug('Matrix audio message transcription failed — using placeholder');
    return { text: VOICE_NOTE_PLACEHOLDER, synthesized: true };
  }

  logger.info({ transcriptLen: transcript.length }, 'Matrix audio message transcribed');
  return { text: transcript, synthesized: false };
}

function buildLeadingMentionRegex(botMxid: string | undefined, botDisplayName: string | undefined): RegExp | null {
  const candidates = [botMxid, botDisplayName]
    .filter((value): value is string => !!value && value.trim().length > 0)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (candidates.length === 0) return null;
  // A real boundary must follow the name: 'Garbanzo help' and 'Garbanzo:'
  // are addressed, 'Garbanzobot help' is a different name entirely.
  return new RegExp(`^(?:${candidates.join('|')})(?:$|[:,\\s]+)`, 'i');
}

async function processMatrixInbound(
  messenger: PlatformMessenger,
  inbound: MatrixInbound,
  env: { ownerId: string; ownerRoomId?: string; botUserId?: string; botDisplayName?: string },
  options: {
    roomEnabled?: MatrixRoomEnabled;
    featureEnabled?: (roomId: string, feature: string) => boolean;
  } = {},
): Promise<void> {
  const mentionRegex = buildLeadingMentionRegex(env.botUserId, env.botDisplayName);
  const roomEnabled = options.roomEnabled ?? isMatrixRoomEnabled;
  const featureEnabled = options.featureEnabled
    ?? ((roomId: string, feature: string) => isMatrixFeatureEnabled(roomId, feature));
  const ownerAlertRoomId = env.ownerRoomId ?? env.ownerId;

  await processInboundMessage(messenger, inbound, {
    isReplyToBot: () => false,

    isAcknowledgment: () => false,

    sendAcknowledgmentReaction: async () => {
      // no-op — Matrix reactions are not implemented in the core adapter.
    },

    handleGroupMessage: async ({ inbound: m, text, hasMedia, audio }) => {
      const trimmed = text.trim();
      const mentionMatch = mentionRegex?.exec(trimmed) ?? null;
      const mentionedInline = !!env.botUserId
        && Array.isArray(m.mentionedIds)
        && m.mentionedIds.includes(env.botUserId);
      const isBang = trimmed.startsWith('!');
      const isAddressed = Boolean(mentionMatch) || mentionedInline || isBang;
      const requiresMention = matrixRoomRequiresMention(m.chatId);

      if (requiresMention && !isAddressed) return;

      const query = mentionMatch ? trimmed.slice(mentionMatch[0].length).trim() : trimmed;
      if (!query && !hasMedia) return;

      await processGroupMessage({
        messenger,
        chatId: m.chatId,
        senderId: m.senderId,
        groupName: getMatrixRoomName(m.chatId) ?? `Matrix ${m.chatId}`,
        ownerId: ownerAlertRoomId,
        ownerUserId: env.ownerId,
        query,
        isFeatureEnabled: featureEnabled,
        getResponse,
        messageId: m.messageId,
        replyTo: m.raw,
        audio,
      });
    },

    handleOwnerDM: async ({ inbound: m, text }) => {
      if (m.senderId !== env.ownerId) return;
      if (env.ownerRoomId && m.chatId !== env.ownerRoomId) return;

      const response = await getResponse(
        text,
        {
          groupName: 'Matrix DM',
          groupJid: m.chatId,
          senderJid: m.senderId,
        },
        featureEnabled,
      );

      if (response) {
        await messenger.sendText(m.chatId, response, { replyTo: m.raw });
      }
    },

    captureForBridge,
  }, {
    ownerId: ownerAlertRoomId,
    isGroupEnabled: roomEnabled,
    shouldIngestGroupChat: config.MATRIX_CHAT_SCOPE === 'configured' ? roomEnabled : undefined,
    introductionsChatId: null,
    eventsChatId: null,
    handleIntroduction: async () => null,
    handleEventPassive: async () => null,
  });
}

export async function processMatrixEvent(
  messenger: PlatformMessenger,
  eventPayload: unknown,
  env: { ownerId: string; ownerRoomId?: string; botUserId?: string; botDisplayName?: string },
): Promise<void> {
  const parsed = MatrixEventSchema.safeParse(eventPayload);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues }, 'Invalid Matrix message payload');
    return;
  }

  const resolved = await resolveAudioText(parsed.data);
  const inbound = normalizeMatrixInbound({ ...parsed.data, text: resolved.text });
  if (resolved.synthesized) inbound.synthesizedPlaceholder = true;
  await processMatrixInbound(messenger, inbound, env);
}
