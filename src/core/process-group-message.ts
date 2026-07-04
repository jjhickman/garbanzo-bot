import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { jidsMatch } from '../utils/jid.js';
import { matchFeature } from '../features/router.js';
import { handlePoll, isDuplicatePoll, recordPoll } from '../features/polls.js';
import { handleCharacter } from '../features/character.js';
import { handleFeedbackSubmit, handleUpvote } from '../features/feedback.js';
import { handleVoiceCommand, formatVoiceList, textToSpeech, isTTSAvailable } from '../features/voice.js';
import { handleSongCommand } from '../features/songs.js';
import { handleAvailabilityCommand, handleRehearsalCommand } from '../features/rehearsals.js';
import { handleSetlistCommand } from '../features/setlists.js';
import { handleAgendaCommand } from '../features/practice-agenda.js';
import { handleIdeaCommand } from '../features/song-ideas.js';
import { handleLyricsCommand, handleSectionCommand } from '../features/song-sections.js';
import { extractUrls, processUrl } from '../features/links.js';
import { maybeExtractCommunityFacts } from '../features/memory-extract.js';
import { isSoftMuted } from '../features/moderation.js';
import { checkRateLimit, recordResponse } from '../middleware/rate-limit.js';
import { recordBotResponse } from '../middleware/stats.js';
import { queueRetry } from '../middleware/retry.js';
import type { MessageContext } from '../ai/persona.js';
import type { VisionImage } from './vision.js';
import type { MessageRef } from './message-ref.js';
import type { PlatformMessenger } from './platform-messenger.js';

export interface ProcessGroupMessageParams {
  messenger: PlatformMessenger;

  chatId: string;
  senderId: string;
  groupName: string;
  ownerId: string;

  /**
   * Identity to compare `senderId` against for owner-gated commands (e.g. `!song`).
   *
   * Defaults to `ownerId` when omitted, which is correct for WhatsApp (where
   * `ownerId` is the owner's own JID — the same space as `senderId`). Discord
   * passes `ownerId` as an *alert-delivery* DM channel id, which is NOT
   * comparable to a Discord user id — Discord callers must pass the real
   * owner user id here explicitly.
   */
  ownerUserId?: string;

  /** True when the sending platform has already identified the sender as a band member. */
  senderIsBandMember?: boolean;

  /** Mention-stripped query string (optionally enriched, e.g. with URL context). */
  query: string;

  isFeatureEnabled: (chatId: string, feature: string) => boolean;
  getResponse: (
    query: string,
    ctx: MessageContext,
    isFeatureEnabled: (chatId: string, feature: string) => boolean,
    visionImages?: VisionImage[],
  ) => Promise<string | null>;

  quotedText?: string;
  messageId?: string;
  replyTo?: MessageRef;

  visionImages?: VisionImage[];

  /**
   * A dropped audio attachment on the message, where the sending platform
   * surfaces it (Discord). Not yet consumed here — threaded through for
   * feature handlers (e.g. the songwriting `!idea` handler) to transcribe.
   */
  audio?: { url: string; contentType: string };
}

/**
 * Core group message processor.
 *
 * This function contains feature routing and AI response generation logic
 * without relying on platform SDK types.
 */
export async function processGroupMessage(params: ProcessGroupMessageParams): Promise<void> {
  const {
    messenger,
    chatId,
    senderId,
    groupName,
    ownerId,
    ownerUserId,
    senderIsBandMember,
    query,
    quotedText,
    messageId,
    replyTo,
    visionImages,
    audio,
    isFeatureEnabled,
    getResponse,
  } = params;

  // Soft-muted users get silently ignored
  if (isSoftMuted(senderId)) {
    logger.debug({ senderId, group: chatId }, 'Ignoring soft-muted user');
    return;
  }

  // Rate limit check
  const rateLimited = checkRateLimit(senderId, chatId);
  if (rateLimited) {
    await messenger.sendText(chatId, rateLimited, { replyTo });
    return;
  }

  const featureCheck = matchFeature(query);

  // Feedback commands — !suggest, !bug, !upvote
  if (featureCheck?.feature === 'feedback' && isFeatureEnabled(chatId, 'feedback')) {
    await handleFeedbackCommand({
      messenger,
      chatId,
      senderId,
      ownerId,
      query,
      replyTo,
    });
    return;
  }

  // Poll command — native poll when available
  if (featureCheck?.feature === 'poll' && isFeatureEnabled(chatId, 'poll')) {
    await handlePollCommand({
      messenger,
      chatId,
      senderId,
      featureQuery: featureCheck.query,
      replyTo,
    });
    return;
  }

  // Character command — text summary + PDF
  if (featureCheck?.feature === 'character' && isFeatureEnabled(chatId, 'character')) {
    await handleCharacterCommand({
      messenger,
      chatId,
      ownerId,
      featureQuery: featureCheck.query,
      replyTo,
    });
    return;
  }

  // Voice command (!voice) — TTS reply
  if (featureCheck?.feature === 'voice' && isFeatureEnabled(chatId, 'voice')) {
    await handleVoiceFeature({
      messenger,
      chatId,
      featureQuery: featureCheck.query,
      quotedText,
      replyTo,
    });
    return;
  }

  // Band feature — !song (shared band memory: setlist tracking)
  if (featureCheck?.feature === 'song' && config.BAND_FEATURES_ENABLED) {
    await handleSongFeature({
      messenger,
      chatId,
      senderId,
      ownerUserId: ownerUserId ?? ownerId,
      senderIsBandMember,
      featureQuery: featureCheck.query,
      replyTo,
    });
    return;
  }

  // Band feature — !rehearsal (shared band practice tracking)
  if (featureCheck?.feature === 'rehearsal' && config.BAND_FEATURES_ENABLED) {
    await handleRehearsalFeature({
      messenger,
      chatId,
      senderId,
      ownerUserId: ownerUserId ?? ownerId,
      senderIsBandMember,
      featureQuery: featureCheck.query,
      replyTo,
    });
    return;
  }

  // Band feature — !available (any band member sets their own availability)
  if (featureCheck?.feature === 'available' && config.BAND_FEATURES_ENABLED) {
    await handleAvailabilityFeature({
      messenger,
      chatId,
      senderId,
      ownerUserId: ownerUserId ?? ownerId,
      senderIsBandMember,
      featureQuery: featureCheck.query,
      replyTo,
    });
    return;
  }

  // Band feature — !setlist (shared band memory: ordered song lists)
  if (featureCheck?.feature === 'setlist' && config.BAND_FEATURES_ENABLED) {
    await handleSetlistFeature({
      messenger,
      chatId,
      senderId,
      ownerUserId: ownerUserId ?? ownerId,
      senderIsBandMember,
      featureQuery: featureCheck.query,
      replyTo,
    });
    return;
  }

  // Band feature — !section (per-song structure: intro/verse/chorus/etc.)
  if (featureCheck?.feature === 'section' && config.BAND_FEATURES_ENABLED) {
    await handleSectionFeature({
      messenger,
      chatId,
      senderId,
      ownerUserId: ownerUserId ?? ownerId,
      senderIsBandMember,
      featureQuery: featureCheck.query,
      replyTo,
    });
    return;
  }

  // Band feature — !lyrics (per-song lyric sheet: show/set)
  if (featureCheck?.feature === 'lyrics' && config.BAND_FEATURES_ENABLED) {
    await handleLyricsFeature({
      messenger,
      chatId,
      senderId,
      ownerUserId: ownerUserId ?? ownerId,
      senderIsBandMember,
      featureQuery: featureCheck.query,
      replyTo,
    });
    return;
  }

  // Band feature — !idea (songwriting scratchpad: capture text or an audio
  // clip → Whisper transcript, plus promote-to-song)
  if (featureCheck?.feature === 'idea' && config.BAND_FEATURES_ENABLED) {
    await handleIdeaFeature({
      messenger,
      chatId,
      senderId,
      ownerUserId: ownerUserId ?? ownerId,
      senderIsBandMember,
      featureQuery: featureCheck.query,
      audio,
      replyTo,
    });
    return;
  }

  // Band feature — !agenda (read-only: any sender in a band-enabled context
  // may view the practice agenda; no owner/band-member gate needed since it
  // can't mutate anything).
  if (featureCheck?.feature === 'agenda' && config.BAND_FEATURES_ENABLED) {
    await handleAgendaFeature({
      messenger,
      chatId,
      senderId,
      replyTo,
    });
    return;
  }

  // URL context enrichment
  let urlContext = '';
  const urls = extractUrls(query);
  if (urls.length > 0) {
    const urlSummary = await processUrl(urls[0]);
    if (urlSummary) {
      urlContext = `\n\n[Shared link context]\n${urlSummary}`;
    }
  }

  const enrichedQuery = urlContext ? query + urlContext : query;

  const response = await getResponse(
    enrichedQuery,
    {
      groupName,
      groupJid: chatId,
      senderJid: senderId,
      quotedText,
    },
    isFeatureEnabled,
    visionImages,
  );

  if (response) {
    // If AI returned the error fallback, queue for retry instead of sending error
    if (response.includes('I hit a snag')) {
      queueRetry({
        groupJid: chatId,
        senderJid: senderId,
        query,
        quotedMsgId: messageId,
        timestamp: Date.now(),
      });
      return;
    }

    recordBotResponse(chatId);
    recordResponse(senderId, chatId);
    await messenger.sendText(chatId, response, { replyTo });
    void maybeExtractCommunityFacts(chatId, groupName).catch((err) => {
      logger.warn({ err, chatId, groupName }, 'Automatic memory extraction trigger failed');
    });
  }
}

async function handleFeedbackCommand(params: {
  messenger: PlatformMessenger;
  chatId: string;
  senderId: string;
  ownerId: string;
  query: string;
  replyTo?: MessageRef;
}): Promise<void> {
  const { messenger, chatId, senderId, ownerId, query, replyTo } = params;

  const bangWord = query.trim().split(/\s+/)[0].toLowerCase().replace('!', '');
  const feedbackArgs = query.trim().slice(query.trim().indexOf(' ') + 1).trim();
  const isBareCommand = !query.trim().includes(' ');

  if (bangWord === 'suggest' || bangWord === 'suggestion') {
    const result = await handleFeedbackSubmit('suggestion', isBareCommand ? '' : feedbackArgs, senderId, chatId);
    await messenger.sendText(chatId, result.response, { replyTo });
    if (result.ownerAlert) {
      try {
        await messenger.sendText(ownerId, result.ownerAlert);
      } catch (err) {
        logger.error({ err, ownerId, senderId, chatId, type: 'suggestion' }, 'Failed to forward feedback to owner');
      }
    }
    recordBotResponse(chatId);
    recordResponse(senderId, chatId);
    return;
  }

  if (bangWord === 'bug') {
    const result = await handleFeedbackSubmit('bug', isBareCommand ? '' : feedbackArgs, senderId, chatId);
    await messenger.sendText(chatId, result.response, { replyTo });
    if (result.ownerAlert) {
      try {
        await messenger.sendText(ownerId, result.ownerAlert);
      } catch (err) {
        logger.error({ err, ownerId, senderId, chatId, type: 'bug' }, 'Failed to forward feedback to owner');
      }
    }
    recordBotResponse(chatId);
    recordResponse(senderId, chatId);
    return;
  }

  if (bangWord === 'upvote') {
    const response = await handleUpvote(isBareCommand ? '' : feedbackArgs, senderId);
    await messenger.sendText(chatId, response, { replyTo });
    recordBotResponse(chatId);
    recordResponse(senderId, chatId);
    return;
  }

  if (bangWord === 'feedback') {
    await messenger.sendText(chatId, [
      '💡 *Submit feedback:*',
      '  !suggest <your idea>',
      '  !bug <what went wrong>',
      '  !upvote <id>',
    ].join('\n'), { replyTo });
  }
}

async function handleSongFeature(params: {
  messenger: PlatformMessenger;
  chatId: string;
  senderId: string;
  ownerUserId: string;
  senderIsBandMember?: boolean;
  featureQuery: string;
  replyTo?: MessageRef;
}): Promise<void> {
  const { messenger, chatId, senderId, ownerUserId, senderIsBandMember, featureQuery, replyTo } = params;

  const isOwner = jidsMatch(senderId, ownerUserId);
  if (!isOwner && senderIsBandMember !== true) {
    await messenger.sendText(chatId, '🎸 Only the owner or band members can manage the setlist right now.', { replyTo });
    return;
  }

  const result = await handleSongCommand(featureQuery);
  await messenger.sendText(chatId, result, { replyTo });
  recordBotResponse(chatId);
  recordResponse(senderId, chatId);
}

async function handleRehearsalFeature(params: {
  messenger: PlatformMessenger;
  chatId: string;
  senderId: string;
  ownerUserId: string;
  senderIsBandMember?: boolean;
  featureQuery: string;
  replyTo?: MessageRef;
}): Promise<void> {
  const { messenger, chatId, senderId, ownerUserId, senderIsBandMember, featureQuery, replyTo } = params;

  const isOwner = jidsMatch(senderId, ownerUserId);
  if (!isOwner && senderIsBandMember !== true) {
    await messenger.sendText(chatId, '🎸 Only the owner or band members can manage rehearsals right now.', { replyTo });
    return;
  }

  const result = await handleRehearsalCommand(featureQuery, { senderId });
  await messenger.sendText(chatId, result, { replyTo });
  recordBotResponse(chatId);
  recordResponse(senderId, chatId);
}

async function handleSetlistFeature(params: {
  messenger: PlatformMessenger;
  chatId: string;
  senderId: string;
  ownerUserId: string;
  senderIsBandMember?: boolean;
  featureQuery: string;
  replyTo?: MessageRef;
}): Promise<void> {
  const { messenger, chatId, senderId, ownerUserId, senderIsBandMember, featureQuery, replyTo } = params;

  const isOwner = jidsMatch(senderId, ownerUserId);
  if (!isOwner && senderIsBandMember !== true) {
    await messenger.sendText(chatId, '🎸 Only the owner or band members can manage setlists right now.', { replyTo });
    return;
  }

  const result = await handleSetlistCommand(featureQuery);
  await messenger.sendText(chatId, result, { replyTo });
  recordBotResponse(chatId);
  recordResponse(senderId, chatId);
}

async function handleSectionFeature(params: {
  messenger: PlatformMessenger;
  chatId: string;
  senderId: string;
  ownerUserId: string;
  senderIsBandMember?: boolean;
  featureQuery: string;
  replyTo?: MessageRef;
}): Promise<void> {
  const { messenger, chatId, senderId, ownerUserId, senderIsBandMember, featureQuery, replyTo } = params;

  const isOwner = jidsMatch(senderId, ownerUserId);
  if (!isOwner && senderIsBandMember !== true) {
    await messenger.sendText(chatId, '🎸 Only the owner or band members can manage song sections right now.', { replyTo });
    return;
  }

  const result = await handleSectionCommand(featureQuery);
  await messenger.sendText(chatId, result, { replyTo });
  recordBotResponse(chatId);
  recordResponse(senderId, chatId);
}

async function handleLyricsFeature(params: {
  messenger: PlatformMessenger;
  chatId: string;
  senderId: string;
  ownerUserId: string;
  senderIsBandMember?: boolean;
  featureQuery: string;
  replyTo?: MessageRef;
}): Promise<void> {
  const { messenger, chatId, senderId, ownerUserId, senderIsBandMember, featureQuery, replyTo } = params;

  const isOwner = jidsMatch(senderId, ownerUserId);
  if (!isOwner && senderIsBandMember !== true) {
    await messenger.sendText(chatId, '🎸 Only the owner or band members can manage lyrics right now.', { replyTo });
    return;
  }

  const result = await handleLyricsCommand(featureQuery);
  await messenger.sendText(chatId, result, { replyTo });
  recordBotResponse(chatId);
  recordResponse(senderId, chatId);
}

async function handleIdeaFeature(params: {
  messenger: PlatformMessenger;
  chatId: string;
  senderId: string;
  ownerUserId: string;
  senderIsBandMember?: boolean;
  featureQuery: string;
  audio?: { url: string; contentType: string };
  replyTo?: MessageRef;
}): Promise<void> {
  const { messenger, chatId, senderId, ownerUserId, senderIsBandMember, featureQuery, audio, replyTo } = params;

  const isOwner = jidsMatch(senderId, ownerUserId);
  if (!isOwner && senderIsBandMember !== true) {
    await messenger.sendText(chatId, '🎸 Only the owner or band members can capture song ideas right now.', { replyTo });
    return;
  }

  const result = await handleIdeaCommand(featureQuery, { senderId, audio });
  await messenger.sendText(chatId, result, { replyTo });
  recordBotResponse(chatId);
  recordResponse(senderId, chatId);
}

async function handleAgendaFeature(params: {
  messenger: PlatformMessenger;
  chatId: string;
  senderId: string;
  replyTo?: MessageRef;
}): Promise<void> {
  const { messenger, chatId, senderId, replyTo } = params;

  const result = await handleAgendaCommand();
  await messenger.sendText(chatId, result, { replyTo });
  recordBotResponse(chatId);
  recordResponse(senderId, chatId);
}

async function handleAvailabilityFeature(params: {
  messenger: PlatformMessenger;
  chatId: string;
  senderId: string;
  ownerUserId: string;
  senderIsBandMember?: boolean;
  featureQuery: string;
  replyTo?: MessageRef;
}): Promise<void> {
  const { messenger, chatId, senderId, ownerUserId, senderIsBandMember, featureQuery, replyTo } = params;

  const isOwner = jidsMatch(senderId, ownerUserId);
  if (!isOwner && senderIsBandMember !== true) {
    await messenger.sendText(chatId, '🎸 Only the owner or band members can set availability right now.', { replyTo });
    return;
  }

  // process-group-message only carries senderId today (no display name available
  // for any platform) — handleAvailabilityCommand falls back to memberId when
  // senderName is undefined.
  const result = await handleAvailabilityCommand(featureQuery, { senderId });
  await messenger.sendText(chatId, result, { replyTo });
  recordBotResponse(chatId);
  recordResponse(senderId, chatId);
}

async function handlePollCommand(params: {
  messenger: PlatformMessenger;
  chatId: string;
  senderId: string;
  featureQuery: string;
  replyTo?: MessageRef;
}): Promise<void> {
  const { messenger, chatId, senderId, featureQuery, replyTo } = params;

  const pollResult = handlePoll(featureQuery);
  if (typeof pollResult === 'string') {
    await messenger.sendText(chatId, pollResult, { replyTo });
    return;
  }

  if (isDuplicatePoll(chatId, pollResult.name)) {
    await messenger.sendText(chatId, '🗳️ A similar poll was already posted in the last hour.', { replyTo });
    return;
  }

  await messenger.sendPoll(chatId, pollResult);
  recordPoll(chatId, pollResult.name);
  recordBotResponse(chatId);
  recordResponse(senderId, chatId);
}

async function handleCharacterCommand(params: {
  messenger: PlatformMessenger;
  chatId: string;
  ownerId: string;
  featureQuery: string;
  replyTo?: MessageRef;
}): Promise<void> {
  const { messenger, chatId, ownerId, featureQuery, replyTo } = params;

  const charResult = await handleCharacter(featureQuery);
  if (typeof charResult === 'string') {
    await messenger.sendText(chatId, charResult, { replyTo });
    return;
  }

  const summaryRef = await messenger.sendTextWithRef(chatId, charResult.summary, { replyTo });
  const pdfRef = await messenger.sendDocument(chatId, {
    bytes: charResult.pdfBytes,
    mimetype: 'application/pdf',
    fileName: charResult.fileName,
  });

  // If validation flagged empty fields, retry once and delete old messages
  if (charResult.hasEmptyFields) {
    logger.warn({ fileName: charResult.fileName }, 'Character PDF had empty fields — regenerating');
    const retryResult = await handleCharacter(featureQuery);
    if (typeof retryResult !== 'string' && !retryResult.hasEmptyFields) {
      await messenger.deleteMessage(chatId, summaryRef);
      await messenger.deleteMessage(chatId, pdfRef);

      await messenger.sendText(chatId, retryResult.summary, { replyTo });
      await messenger.sendDocument(chatId, {
        bytes: retryResult.pdfBytes,
        mimetype: 'application/pdf',
        fileName: retryResult.fileName,
      });

      logger.info({ fileName: retryResult.fileName }, 'Character PDF retry sent, old messages deleted');
    }
  }

  recordBotResponse(chatId);
  recordResponse(ownerId, chatId);
}

async function handleVoiceFeature(params: {
  messenger: PlatformMessenger;
  chatId: string;
  featureQuery: string;
  quotedText?: string;
  replyTo?: MessageRef;
}): Promise<void> {
  const { messenger, chatId, featureQuery, quotedText, replyTo } = params;

  const voiceCmd = handleVoiceCommand(featureQuery);
  if (voiceCmd.action === 'list') {
    await messenger.sendText(chatId, formatVoiceList(), { replyTo });
    return;
  }

  if (!isTTSAvailable()) {
    await messenger.sendText(chatId, '🎙️ Voice feature is not configured on this server.', { replyTo });
    return;
  }

  const textToSpeak = quotedText ?? featureQuery;
  if (!textToSpeak || textToSpeak === voiceCmd.voiceId) {
    await messenger.sendText(chatId, '🎙️ Reply to a message with `!voice` to hear it spoken, or `!voice list` for available voices.', { replyTo });
    return;
  }

  const audio = await textToSpeech(textToSpeak, voiceCmd.voiceId);
  if (!audio) {
    await messenger.sendText(chatId, '🎙️ Voice generation failed. Try again.', { replyTo });
    return;
  }

  await messenger.sendAudio(chatId, {
    bytes: audio,
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true,
  }, { replyTo });
}
