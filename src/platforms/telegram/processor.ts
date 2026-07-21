import { z } from 'zod';

import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import { processInboundMessage } from '../../core/process-inbound-message.js';
import { processGroupMessage } from '../../core/process-group-message.js';
import { getResponse } from '../../core/response-router.js';
import type { PlatformMessenger } from '../../core/platform-messenger.js';
import { createMessageRef } from '../../core/message-ref.js';
import { captureForBridge } from '../../bridge/capture-hook.js';
import { transcribeAudio } from '../../features/voice.js';
import { readAttachments } from '../../core/attachment-reading.js';
import type { VisionImage } from '../../core/vision.js';

import { collectTelegramAttachments } from './attachment-reading.js';
import type { TelegramInbound } from './inbound.js';
import {
  getTelegramChatName,
  isTelegramChatEnabled,
  isTelegramFeatureEnabled,
  telegramChatRequiresMention,
} from './telegram-config.js';

// F1 (T2 review): shared with the bridge's own media-placeholder text
// (src/bridge/relay-capture.ts uses the same literal) — a voice note that
// can't be transcribed still reaches the core pipeline as text instead of
// being silently dropped, per the v3.3 plan's WS3 placeholder-on-failure
// semantics.
import { VOICE_NOTE_PLACEHOLDER } from '../../core/inbound-message.js';

const TelegramAudioSchema = z.object({
  url: z.string(),
  contentType: z.string(),
  buffer: z.instanceof(Buffer).optional(),
  ptt: z.boolean().optional(),
});

const TelegramMediaSchema = z.object({
  url: z.string().optional(),
  contentType: z.string(),
  fileName: z.string().optional(),
  buffer: z.instanceof(Buffer).optional(),
  kind: z.enum(['image', 'document', 'audio']),
});

const TelegramEventSchema = z.object({
  messageId: z.string(),
  chatId: z.string(),
  isGroupChat: z.boolean(),
  text: z.string().default(''),
  senderId: z.string(),
  senderName: z.string().optional(),
  timestampMs: z.number(),
  quotedText: z.string().optional(),
  fromSelf: z.boolean().default(false),
  mentionedIds: z.array(z.string()).optional(),
  audio: TelegramAudioSchema.optional(),
  media: TelegramMediaSchema.optional(),
  quotedAudio: TelegramAudioSchema.optional(),
  quotedMedia: TelegramMediaSchema.optional(),
});

type TelegramEvent = z.infer<typeof TelegramEventSchema>;
type TelegramChannelEnabled = (chatId: string) => boolean;

function normalizeTelegramInbound(event: TelegramEvent): TelegramInbound {
  return {
    platform: 'telegram',
    chatId: event.chatId,
    chatName: getTelegramChatName(event.chatId),
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
    // Audio FILES ride `media` (kind 'audio') so the core no-content gate
    // still passes a captionless mp3 through to group dispatch, but they are
    // NOT visual media: bridge capture must never relay an `[image]`
    // placeholder for them. (No `hasReadableAttachment` marker needed here,
    // unlike WhatsApp: `media` presence already satisfies the core gate.)
    hasVisualMedia: Boolean(event.media && event.media.kind !== 'audio'),
    audio: event.audio,
    media: event.media,
    quotedAudio: event.quotedAudio,
    quotedMedia: event.quotedMedia,
    raw: createMessageRef({
      platform: 'telegram',
      chatId: event.chatId,
      id: event.messageId,
      ref: {
        kind: 'telegram-inbound',
        chatId: event.chatId,
        messageId: event.messageId,
      },
    }),
  };
}

/**
 * F1 (T2 review): captionless voice messages leave `event.text` empty, and
 * the core gate at process-inbound-message.ts drops any message with no
 * text and no visual media — so voice was previously dead code end to end.
 * This mirrors whatsapp/processor.ts's inline transcription (reuse, not a
 * fork), transcribing the already-downloaded buffer (client.ts's
 * downloadTelegramVoice) via the same Whisper-backed transcribeAudio path.
 * Unlike whatsapp/processor.ts today, failure never drops the message: per
 * the v3.3 plan's WS3 semantics, a failed/unavailable transcription
 * continues with a `[voice note]` placeholder so moderation, capture, and
 * bridging still see SOMETHING rather than silence.
 */
async function resolveVoiceText(event: TelegramEvent): Promise<{ text: string; synthesized: boolean }> {
  // A captioned voice message already has text (client.ts maps `caption`
  // into `text`) — only a captionless voice message needs transcription.
  if (event.text || !event.audio) return { text: event.text, synthesized: false };

  if (!event.audio.buffer) {
    logger.debug('Telegram voice message download unavailable — using placeholder');
    return { text: VOICE_NOTE_PLACEHOLDER, synthesized: true };
  }

  const transcript = await transcribeAudio(event.audio.buffer, event.audio.contentType);
  if (!transcript) {
    logger.debug('Telegram voice message transcription failed — using placeholder');
    return { text: VOICE_NOTE_PLACEHOLDER, synthesized: true };
  }

  logger.info({ transcriptLen: transcript.length }, 'Telegram voice message transcribed');
  return { text: transcript, synthesized: false };
}

function buildTelegramMentionRegex(botUsername: string | undefined): RegExp | null {
  if (!botUsername || botUsername.trim().length === 0) return null;
  const escaped = botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^@${escaped}[:\\s]*`, 'i');
}

async function processTelegramInbound(
  messenger: PlatformMessenger,
  inbound: TelegramInbound,
  env: { ownerId: string; ownerUserId?: string; botUserId?: string; botUsername?: string },
  options: {
    chatEnabled?: TelegramChannelEnabled;
    featureEnabled?: (chatId: string, feature: string) => boolean;
  } = {},
): Promise<void> {
  const mentionRegex = buildTelegramMentionRegex(env.botUsername);
  const chatEnabled = options.chatEnabled ?? isTelegramChatEnabled;
  const featureEnabled = options.featureEnabled
    ?? ((chatId: string, feature: string) => isTelegramFeatureEnabled(chatId, feature));

  await processInboundMessage(messenger, inbound, {
    isReplyToBot: () => false,

    isAcknowledgment: () => false,

    sendAcknowledgmentReaction: async () => {
      // no-op — Telegram acknowledgment reactions are not implemented (matches Discord).
    },

    handleGroupMessage: async ({ inbound: m, text, hasMedia, audio }) => {
      const trimmed = text.trim();
      const mentionMatch = mentionRegex?.exec(trimmed) ?? null;
      // client.ts pre-computes "was this message addressed to the bot" (an
      // @username mention or a reply to one of the bot's own messages) into
      // mentionedIds, the same signal Discord's mentionedIds carries.
      const mentionedInline = !!env.botUserId
        && Array.isArray(m.mentionedIds)
        && m.mentionedIds.includes(env.botUserId);
      const isBang = trimmed.startsWith('!');
      const isAddressed = Boolean(mentionMatch) || mentionedInline || isBang;
      const requiresMention = telegramChatRequiresMention(m.chatId);

      if (requiresMention && !isAddressed) return;

      const query = mentionMatch ? trimmed.slice(mentionMatch[0].length).trim() : trimmed;

      const hasQuotedAttachment = Boolean(m.quotedAudio || m.quotedMedia);
      if (!query && !hasMedia && !hasQuotedAttachment) return;

      // Attachment reading (engagement already decided above). Bang commands
      // are skipped entirely: feature handlers own their raw queries. Direct
      // voice is NOT re-read here — resolveVoiceText already owns that flow.
      let visionImages: VisionImage[] | undefined;
      let enrichedQuery = query;
      if (!isBang) {
        const attachments = collectTelegramAttachments(m, config.TELEGRAM_BOT_TOKEN);
        if (attachments.length > 0) {
          const read = await readAttachments(attachments, query);
          visionImages = read.visionImages;
          enrichedQuery = read.enrichedQuery;
        }
      }
      if (!enrichedQuery && !visionImages && !audio) return;

      await processGroupMessage({
        messenger,
        chatId: m.chatId,
        senderId: m.senderId,
        groupName: getTelegramChatName(m.chatId) ?? `Telegram ${m.chatId}`,
        ownerId: env.ownerId,
        ownerUserId: env.ownerUserId,
        query: enrichedQuery,
        isFeatureEnabled: featureEnabled,
        getResponse,
        messageId: m.messageId,
        replyTo: m.raw,
        audio,
        visionImages,
      });
    },

    handleOwnerDM: async ({ inbound: m, text }) => {
      if (!env.ownerUserId || m.senderId !== env.ownerUserId) return;

      const response = await getResponse(
        text,
        {
          groupName: 'Telegram DM',
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
    ownerId: env.ownerId,
    isGroupEnabled: chatEnabled,
    // F6 (T2 review): default 'configured' (deliberately different from
    // WhatsApp's 'all' default) — anyone can add a Telegram bot to any
    // group, so an unconfigured group must not get ingested (recorded,
    // moderated, bridge-captured) by default the way an unconfigured
    // WhatsApp/Discord chat does. Operators who DO want every group
    // ingested (matching WhatsApp's default) can opt in via
    // TELEGRAM_CHAT_SCOPE=all.
    shouldIngestGroupChat: config.TELEGRAM_CHAT_SCOPE === 'configured' ? chatEnabled : undefined,
    // Introductions/events passive-detection channels are not part of the
    // Telegram core adapter (T2 scope) — reuse the same core pipeline with
    // both disabled rather than forking it.
    introductionsChatId: null,
    eventsChatId: null,
    handleIntroduction: async () => null,
    handleEventPassive: async () => null,
  });
}

/**
 * Process a normalized Telegram message event (built by client.ts's
 * mapTelegramMessageToPayload) through the shared core dispatch pipeline.
 */
export async function processTelegramEvent(
  messenger: PlatformMessenger,
  eventPayload: unknown,
  env: { ownerId: string; ownerUserId?: string; botUserId?: string; botUsername?: string },
): Promise<void> {
  const parsed = TelegramEventSchema.safeParse(eventPayload);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues }, 'Invalid Telegram message payload');
    return;
  }

  const resolved = await resolveVoiceText(parsed.data);
  const inbound = normalizeTelegramInbound({ ...parsed.data, text: resolved.text });
  if (resolved.synthesized) inbound.synthesizedPlaceholder = true;
  await processTelegramInbound(messenger, inbound, env);
}
