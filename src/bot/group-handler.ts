import type { WASocket, WAMessage, WAMessageContent } from '@whiskeysockets/baileys';
import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { requiresMention, isMentioned, stripMention, getGroupName, isFeatureEnabled } from './groups.js';
import { matchFeature } from '../features/router.js';
import { handlePoll, isDuplicatePoll, recordPoll } from '../features/polls.js';
import { handleCharacter } from '../features/character.js';
import { handleFeedbackSubmit, handleUpvote } from '../features/feedback.js';
import { handleVoiceCommand, formatVoiceList, textToSpeech, isTTSAvailable } from '../features/voice.js';
import { extractMedia, prepareForVision, type VisionImage } from '../features/media.js';
import { extractUrls, processUrl } from '../features/links.js';
import { isSoftMuted } from '../features/moderation.js';
import { checkRateLimit, recordResponse } from '../middleware/rate-limit.js';
import { recordBotResponse } from '../middleware/stats.js';
import { queueRetry } from '../middleware/retry.js';
import { getResponse, extractQuotedText, extractMentionedJids } from './handlers.js';

/**
 * Handle a group message that has already passed preprocessing
 * (sanitization, moderation, context recording, intro/events passive handlers).
 *
 * This covers mention detection, feature routing, media handling,
 * voice transcription, URL extraction, and AI response generation.
 */
export async function handleGroupMessage(
  sock: WASocket,
  msg: WAMessage,
  remoteJid: string,
  senderJid: string,
  text: string,
  content: WAMessageContent | undefined,
  hasMedia: boolean,
): Promise<void> {
  // Only respond if @mentioned (when group requires it)
  const mentionedJids = extractMentionedJids(content);
  const botJid = sock.user?.id;
  const botLid = sock.user?.lid;

  logger.debug({
    text,
    mentionedJids,
    botJid,
    botLid,
    requiresMention: requiresMention(remoteJid),
    isMentioned: isMentioned(text, mentionedJids, botJid, botLid),
  }, 'Mention check');

  // Bang commands (!command) bypass the mention requirement — users expect them to just work
  const isBangCommand = /^\s*!/.test(text);
  if (requiresMention(remoteJid) && !isBangCommand && !isMentioned(text, mentionedJids, botJid, botLid)) return;

  // Soft-muted users get silently ignored
  if (isSoftMuted(senderJid)) {
    logger.debug({ senderJid, group: remoteJid }, 'Ignoring soft-muted user');
    return;
  }

  const query = stripMention(text, botJid, botLid);
  const groupName = getGroupName(remoteJid);

  logger.info({ group: groupName, sender: senderJid, query }, 'Group mention');

  // Rate limit check
  const rateLimited = checkRateLimit(senderJid, remoteJid);
  if (rateLimited) {
    await sock.sendMessage(remoteJid, { text: rateLimited }, { quoted: msg });
    return;
  }

  // Check for feedback commands — !suggest, !bug, !upvote (group + owner DM)
  const featureCheck = matchFeature(query);
  if (featureCheck?.feature === 'feedback' && isFeatureEnabled(remoteJid, 'feedback')) {
    await handleFeedbackCommand(sock, msg, remoteJid, senderJid, query, featureCheck);
    return;
  }

  // Check for poll command — sends native WhatsApp poll instead of text
  if (featureCheck?.feature === 'poll' && isFeatureEnabled(remoteJid, 'poll')) {
    await handlePollCommand(sock, msg, remoteJid, senderJid, featureCheck);
    return;
  }

  // Check for character command — sends PDF document + text summary
  if (featureCheck?.feature === 'character' && isFeatureEnabled(remoteJid, 'character')) {
    await handleCharacterCommand(sock, msg, remoteJid, senderJid, featureCheck);
    return;
  }

  // Voice command (!voice) — TTS reply
  if (featureCheck?.feature === 'voice' && isFeatureEnabled(remoteJid, 'voice')) {
    await handleVoiceFeature(sock, msg, remoteJid, senderJid, content, featureCheck);
    return;
  }

  // Media understanding (images, videos, stickers, GIFs)
  let visionImages: VisionImage[] | undefined;
  if (hasMedia) {
    const media = await extractMedia(msg);
    if (media) {
      const images = await prepareForVision(media);
      if (images.length > 0) {
        visionImages = images;
        logger.info({ type: media.type, imageCount: images.length }, 'Media prepared for vision');
      }
    }
  }

  // URL context enrichment
  let urlContext = '';
  const urls = extractUrls(query);
  if (urls.length > 0) {
    // Process first URL only (avoid long delays)
    const urlSummary = await processUrl(urls[0]);
    if (urlSummary) {
      urlContext = `\n\n[Shared link context]\n${urlSummary}`;
    }
  }

  const enrichedQuery = urlContext ? query + urlContext : query;

  const response = await getResponse(enrichedQuery, {
    groupName,
    groupJid: remoteJid,
    senderJid,
    quotedText: extractQuotedText(content),
  }, visionImages);

  if (response) {
    // If AI returned the error fallback, queue for retry instead of sending error
    if (response.includes('I hit a snag')) {
      queueRetry({
        groupJid: remoteJid,
        senderJid,
        query,
        quotedMsgId: msg.key.id ?? undefined,
        timestamp: Date.now(),
      });
      return;
    }
    recordBotResponse(remoteJid);
    recordResponse(senderJid, remoteJid);
    await sock.sendMessage(remoteJid, { text: response }, { quoted: msg });
  }
}

// ── Sub-handlers for complex feature commands ──────────────────────

interface FeatureMatch {
  feature: string;
  query: string;
}

async function handleFeedbackCommand(
  sock: WASocket,
  msg: WAMessage,
  remoteJid: string,
  senderJid: string,
  query: string,
  _featureCheck: FeatureMatch,
): Promise<void> {
  const bangWord = query.trim().split(/\s+/)[0].toLowerCase().replace('!', '');
  const feedbackArgs = query.trim().slice(query.trim().indexOf(' ') + 1).trim();
  const isBareCommand = !query.trim().includes(' ');

  if (bangWord === 'suggest' || bangWord === 'suggestion') {
    const result = handleFeedbackSubmit('suggestion', isBareCommand ? '' : feedbackArgs, senderJid, remoteJid);
    await sock.sendMessage(remoteJid, { text: result.response }, { quoted: msg });
    if (result.ownerAlert) {
      try {
        await sock.sendMessage(config.OWNER_JID, { text: result.ownerAlert });
      } catch (err) {
        logger.error({ err }, 'Failed to forward feedback to owner');
      }
    }
    recordBotResponse(remoteJid);
    recordResponse(senderJid, remoteJid);
  } else if (bangWord === 'bug') {
    const result = handleFeedbackSubmit('bug', isBareCommand ? '' : feedbackArgs, senderJid, remoteJid);
    await sock.sendMessage(remoteJid, { text: result.response }, { quoted: msg });
    if (result.ownerAlert) {
      try {
        await sock.sendMessage(config.OWNER_JID, { text: result.ownerAlert });
      } catch (err) {
        logger.error({ err }, 'Failed to forward feedback to owner');
      }
    }
    recordBotResponse(remoteJid);
    recordResponse(senderJid, remoteJid);
  } else if (bangWord === 'upvote') {
    const response = handleUpvote(isBareCommand ? '' : feedbackArgs, senderJid);
    await sock.sendMessage(remoteJid, { text: response }, { quoted: msg });
    recordBotResponse(remoteJid);
    recordResponse(senderJid, remoteJid);
  } else if (bangWord === 'feedback') {
    // !feedback in a group — show brief help, full management is owner DM only
    await sock.sendMessage(remoteJid, {
      text: [
        '💡 *Submit feedback:*',
        '  !suggest <your idea>',
        '  !bug <what went wrong>',
        '  !upvote <id>',
      ].join('\n'),
    }, { quoted: msg });
  }
}

async function handlePollCommand(
  sock: WASocket,
  msg: WAMessage,
  remoteJid: string,
  senderJid: string,
  featureCheck: FeatureMatch,
): Promise<void> {
  const pollResult = handlePoll(featureCheck.query);
  if (typeof pollResult === 'string') {
    // Error/help message
    await sock.sendMessage(remoteJid, { text: pollResult }, { quoted: msg });
  } else if (isDuplicatePoll(remoteJid, pollResult.name)) {
    await sock.sendMessage(remoteJid, { text: '🗳️ A similar poll was already posted in the last hour.' }, { quoted: msg });
  } else {
    // Send native WhatsApp poll
    await sock.sendMessage(remoteJid, { poll: pollResult });
    recordPoll(remoteJid, pollResult.name);
    recordBotResponse(remoteJid);
    recordResponse(senderJid, remoteJid);
  }
}

async function handleCharacterCommand(
  sock: WASocket,
  msg: WAMessage,
  remoteJid: string,
  senderJid: string,
  featureCheck: FeatureMatch,
): Promise<void> {
  const charResult = await handleCharacter(featureCheck.query);
  if (typeof charResult === 'string') {
    await sock.sendMessage(remoteJid, { text: charResult }, { quoted: msg });
  } else {
    // Send text summary first, then PDF document
    const summaryMsg = await sock.sendMessage(remoteJid, { text: charResult.summary }, { quoted: msg });
    const pdfMsg = await sock.sendMessage(remoteJid, {
      document: Buffer.from(charResult.pdfBytes),
      mimetype: 'application/pdf',
      fileName: charResult.fileName,
    });

    // If validation flagged empty fields, retry once and delete old messages
    if (charResult.hasEmptyFields) {
      logger.warn({ fileName: charResult.fileName }, 'Character PDF had empty fields — regenerating');
      const retryResult = await handleCharacter(featureCheck.query);
      if (typeof retryResult !== 'string' && !retryResult.hasEmptyFields) {
        // Delete previous attempt
        if (summaryMsg?.key) {
          await sock.sendMessage(remoteJid, { delete: summaryMsg.key });
        }
        if (pdfMsg?.key) {
          await sock.sendMessage(remoteJid, { delete: pdfMsg.key });
        }
        // Send corrected version
        await sock.sendMessage(remoteJid, { text: retryResult.summary }, { quoted: msg });
        await sock.sendMessage(remoteJid, {
          document: Buffer.from(retryResult.pdfBytes),
          mimetype: 'application/pdf',
          fileName: retryResult.fileName,
        });
        logger.info({ fileName: retryResult.fileName }, 'Character PDF retry sent, old messages deleted');
      }
    }

    recordBotResponse(remoteJid);
    recordResponse(senderJid, remoteJid);
  }
}

async function handleVoiceFeature(
  sock: WASocket,
  msg: WAMessage,
  remoteJid: string,
  senderJid: string,
  content: WAMessageContent | undefined,
  featureCheck: FeatureMatch,
): Promise<void> {
  const voiceCmd = handleVoiceCommand(featureCheck.query);
  if (voiceCmd.action === 'list') {
    await sock.sendMessage(remoteJid, { text: formatVoiceList() }, { quoted: msg });
  } else if (isTTSAvailable()) {
    // Speak the quoted/replied-to text, or the voice command args
    const textToSpeak = extractQuotedText(content) ?? featureCheck.query;
    if (!textToSpeak || textToSpeak === voiceCmd.voiceId) {
      await sock.sendMessage(remoteJid, {
        text: '🎙️ Reply to a message with `!voice` to hear it spoken, or `!voice list` for available voices.',
      }, { quoted: msg });
    } else {
      const audio = await textToSpeech(textToSpeak, voiceCmd.voiceId);
      if (audio) {
        await sock.sendMessage(remoteJid, {
          audio,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
        }, { quoted: msg });
        recordBotResponse(remoteJid);
        recordResponse(senderJid, remoteJid);
      } else {
        await sock.sendMessage(remoteJid, { text: '🎙️ Voice generation failed. Try again.' }, { quoted: msg });
      }
    }
  } else {
    await sock.sendMessage(remoteJid, { text: '🎙️ Voice feature is not configured on this server.' }, { quoted: msg });
  }
}
