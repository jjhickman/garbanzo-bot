import { logger } from '../middleware/logger.js';
import { matchFeature } from '../features/router.js';
import { handlePoll, isDuplicatePoll, recordPoll } from '../features/polls.js';
import { handleCharacter } from '../features/character.js';
import { handleFeedbackSubmit, handleUpvote } from '../features/feedback.js';
import { handleVoiceCommand, formatVoiceList, textToSpeech, isTTSAvailable } from '../features/voice.js';
import { extractUrls, processUrl } from '../features/links.js';
import { isSoftMuted } from '../features/moderation.js';
import { checkRateLimit, recordResponse } from '../middleware/rate-limit.js';
import { recordBotResponse } from '../middleware/stats.js';
import { queueRetry } from '../middleware/retry.js';
import type { MessageContext } from '../ai/persona.js';
import type { VisionImage } from './vision.js';
import type { PlatformMessenger } from './platform-messenger.js';

export interface ProcessGroupMessageParams {
  messenger: PlatformMessenger;

  chatId: string;
  senderId: string;
  groupName: string;
  ownerId: string;

  /** Mention-stripped query string (optionally enriched, e.g. with URL context). */
  query: string;

  isFeatureEnabled: (chatId: string, feature: string) => boolean;
  getResponse: (query: string, ctx: MessageContext, visionImages?: VisionImage[]) => Promise<string | null>;

  quotedText?: string;
  messageId?: string;
  replyTo?: unknown;

  visionImages?: VisionImage[];
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
    query,
    quotedText,
    messageId,
    replyTo,
    visionImages,
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

  const response = await getResponse(enrichedQuery, {
    groupName,
    groupJid: chatId,
    senderJid: senderId,
    quotedText,
  }, visionImages);

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
  }
}

async function handleFeedbackCommand(params: {
  messenger: PlatformMessenger;
  chatId: string;
  senderId: string;
  ownerId: string;
  query: string;
  replyTo?: unknown;
}): Promise<void> {
  const { messenger, chatId, senderId, ownerId, query, replyTo } = params;

  const bangWord = query.trim().split(/\s+/)[0].toLowerCase().replace('!', '');
  const feedbackArgs = query.trim().slice(query.trim().indexOf(' ') + 1).trim();
  const isBareCommand = !query.trim().includes(' ');

  if (bangWord === 'suggest' || bangWord === 'suggestion') {
    const result = handleFeedbackSubmit('suggestion', isBareCommand ? '' : feedbackArgs, senderId, chatId);
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
    const result = handleFeedbackSubmit('bug', isBareCommand ? '' : feedbackArgs, senderId, chatId);
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
    const response = handleUpvote(isBareCommand ? '' : feedbackArgs, senderId);
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

async function handlePollCommand(params: {
  messenger: PlatformMessenger;
  chatId: string;
  senderId: string;
  featureQuery: string;
  replyTo?: unknown;
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
  replyTo?: unknown;
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
  replyTo?: unknown;
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
