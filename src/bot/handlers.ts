import {
  type WASocket,
  type WAMessage,
  type WAMessageContent,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';
import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { isGroupJid, getSenderJid } from '../utils/jid.js';
import { isGroupEnabled, requiresMention, isMentioned, stripMention, getGroupName, isFeatureEnabled } from './groups.js';
import { getAIResponse } from '../ai/router.js';
import { matchFeature } from '../features/router.js';
import { handleWeather } from '../features/weather.js';
import { handleTransit } from '../features/transit.js';
import { buildWelcomeMessage } from '../features/welcome.js';
import { checkMessage, formatModerationAlert, applyStrikeAndMute, isSoftMuted, formatStrikesReport } from '../features/moderation.js';
import { handleNews } from '../features/news.js';
import { getHelpMessage, getOwnerHelpMessage } from '../features/help.js';
import { handleIntroduction, INTRODUCTIONS_JID, triggerIntroCatchUp } from '../features/introductions.js';
import { handleEvent, handleEventPassive, EVENTS_JID } from '../features/events.js';
import { handleDnd } from '../features/dnd.js';
import { handleBooks } from '../features/books.js';
import { handleVenues } from '../features/venues.js';
import { handlePoll, isDuplicatePoll, recordPoll } from '../features/polls.js';
import { handleFun } from '../features/fun.js';
import { handleCharacter } from '../features/character.js';
import { handleFeedbackSubmit, handleUpvote, handleFeedbackOwner } from '../features/feedback.js';
import { handleRelease } from '../features/release.js';
import { handleProfile } from '../features/profiles.js';
import { handleSummary } from '../features/summary.js';
import { handleRecommendations } from '../features/recommendations.js';
import { handleMemory } from '../features/memory.js';
import { sanitizeMessage } from '../middleware/sanitize.js';
import { touchProfile, updateActiveGroups, logModeration } from '../utils/db.js';
import { recordMessage } from '../middleware/context.js';
import { recordGroupMessage, recordBotResponse, recordModerationFlag, recordOwnerDM } from '../middleware/stats.js';
import { previewDigest } from '../features/digest.js';
import { checkRateLimit, recordResponse } from '../middleware/rate-limit.js';
import { markMessageReceived } from '../middleware/health.js';
import { queueRetry, setRetryHandler, type RetryEntry } from '../middleware/retry.js';
import { extractMedia, hasVisualMedia, isVoiceMessage, downloadVoiceAudio, prepareForVision, type VisionImage } from '../features/media.js';
import { transcribeAudio, textToSpeech, handleVoiceCommand, formatVoiceList, isTTSAvailable } from '../features/voice.js';
import { extractUrls, processUrl } from '../features/links.js';

/**
 * Register all message event handlers on the socket.
 * This is the main message routing logic.
 */
export function registerHandlers(sock: WASocket): void {
  // Register retry handler — retries send the AI response directly
  setRetryHandler(async (entry: RetryEntry) => {
    const groupName = getGroupName(entry.groupJid);
    const response = await getResponse(entry.query, {
      groupName,
      groupJid: entry.groupJid,
      senderJid: entry.senderJid,
    });
    if (response) {
      await sock.sendMessage(entry.groupJid, { text: response });
      recordBotResponse(entry.groupJid);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      try {
        // Process all message types for the Introductions group (catch-up path),
        // but only real-time ('notify') messages for everything else.
        const isIntroGroup = msg.key.remoteJid === INTRODUCTIONS_JID;
        if (type !== 'notify' && !isIntroGroup) continue;

        await handleMessage(sock, msg);
      } catch (err) {
        logger.error({ err, msgId: msg.key.id }, 'Error handling message');
      }
    }
  });

  sock.ev.on('group-participants.update', async (update) => {
    logger.info(
      { group: update.id, action: update.action, count: update.participants.length },
      'Group participant update',
    );

    if (update.action === 'add' && isGroupEnabled(update.id)) {
      const welcome = buildWelcomeMessage(update.id, update.participants);
      if (welcome) {
        try {
          await sock.sendMessage(update.id, { text: welcome });
        } catch (err) {
          logger.error({ err, group: update.id }, 'Failed to send welcome message');
        }
      }
    }
  });

  logger.info('Message handlers registered');
}

/**
 * Unwrap the message content, handling ephemeral/viewOnce/protocol wrappers
 * that WhatsApp applies in groups with disappearing messages etc.
 */
function unwrapMessage(msg: WAMessage): WAMessageContent | undefined {
  return normalizeMessageContent(msg.message);
}

/** Maximum age (in seconds) for a message to be processed. Older messages are silently ignored. */
const MAX_MESSAGE_AGE_SECONDS = 5 * 60; // 5 minutes

/**
 * Route a single incoming message.
 */
async function handleMessage(sock: WASocket, msg: WAMessage): Promise<void> {
  // Track message freshness for staleness detection
  markMessageReceived();

  // Ignore messages sent by the bot itself
  if (msg.key.fromMe) return;

  // Ignore status broadcasts
  if (msg.key.remoteJid === 'status@broadcast') return;

  // Ignore stale messages (e.g. delivered after bot was offline for a while)
  // Exception: Introductions group — intros are caught up via dedup tracker
  const isIntroGroupMsg = msg.key.remoteJid === INTRODUCTIONS_JID;
  if (isStale(msg) && !isIntroGroupMsg) return;

  const remoteJid = msg.key.remoteJid;
  if (!remoteJid) return;

  const content = unwrapMessage(msg);
  let rawText = extractText(content);

  logger.debug({
    remoteJid,
    hasMessage: !!msg.message,
    hasContent: !!content,
    hasText: !!rawText,
    messageKeys: msg.message ? Object.keys(msg.message) : [],
    contentKeys: content ? Object.keys(content) : [],
  }, 'Message received');

  // ── Voice message transcription ──
  // If it's a voice note, transcribe it and use the transcript as the message text.
  const isVoice = isVoiceMessage(msg);
  if (isVoice) {
    const audioBuffer = await downloadVoiceAudio(msg);
    if (audioBuffer) {
      const transcript = await transcribeAudio(audioBuffer, 'audio/ogg');
      if (transcript) {
        logger.info({ transcriptLen: transcript.length }, 'Voice message transcribed');
        rawText = transcript;
      } else {
        logger.debug('Voice message transcription failed — skipping');
        return;
      }
    } else {
      return;
    }
  }

  // Allow messages with visual media through even without text (e.g. image-only)
  const hasMedia = hasVisualMedia(msg);
  if (!rawText && !hasMedia) return;

  // ── Input sanitization ──
  const sanitized = sanitizeMessage(rawText ?? '');
  if (sanitized.rejected) {
    logger.debug({ reason: sanitized.rejectionReason }, 'Message rejected by sanitizer');
    return;
  }
  const text = sanitized.text;

  const senderJid = getSenderJid(remoteJid, msg.key.participant);

  // ── Record message for conversation context + stats + profile ──
  recordMessage(remoteJid, senderJid, text);
  if (isGroupJid(remoteJid)) {
    recordGroupMessage(remoteJid, senderJid);
    // Passive profile tracking — update first/last seen and active groups
    touchProfile(senderJid);
    updateActiveGroups(senderJid, remoteJid);
  }

  // ── Moderation (runs on ALL group messages, not just mentions) ──
  if (isGroupJid(remoteJid) && isGroupEnabled(remoteJid)) {
    const flag = await checkMessage(text);
    if (flag) {
      recordModerationFlag(remoteJid);
      logModeration({
        chatJid: remoteJid,
        sender: senderJid,
        text: text.slice(0, 500),
        reason: flag.reason,
        severity: flag.severity,
        source: flag.source,
        timestamp: Math.floor(Date.now() / 1000),
      });
      logger.warn({ group: remoteJid, sender: senderJid, reason: flag.reason, severity: flag.severity, source: flag.source }, 'Moderation flag');
      const alert = formatModerationAlert(flag, text, senderJid, remoteJid);
      try {
        logger.info({ ownerJid: config.OWNER_JID }, 'Sending moderation alert to owner');
        const result = await sock.sendMessage(config.OWNER_JID, { text: alert });
        logger.info({ msgId: result?.key?.id, to: result?.key?.remoteJid }, 'Moderation alert sent');
      } catch (err) {
        logger.error({ err }, 'Failed to send moderation alert to owner');
      }

      // Apply strike and soft-mute if threshold reached
      const { muted, dmMessage } = applyStrikeAndMute(senderJid);
      if (muted && dmMessage) {
        try {
          await sock.sendMessage(senderJid, { text: dmMessage });
          logger.info({ senderJid }, 'Soft-mute DM sent to user');
        } catch (err) {
          logger.error({ err, senderJid }, 'Failed to send soft-mute DM');
        }
      }
    }
  }

  // ── Introductions (auto-respond, no @mention needed) ──
  // Only top-level messages can be intros — replies to other messages are
  // members welcoming/chatting with the new person, not introducing themselves.
  if (remoteJid === INTRODUCTIONS_JID) {
    const isReply = !!content?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!isReply) {
      const messageId = msg.key.id;
      if (messageId) {
        const introResponse = await handleIntroduction(text, messageId, senderJid, remoteJid);
        if (introResponse) {
          await sock.sendMessage(remoteJid, { text: introResponse }, { quoted: msg });
          return; // Intro handled — don't also process as a general message
        }
      }
    }
  }

  // ── Events group (passive detection, no @mention needed) ──
  if (remoteJid === EVENTS_JID) {
    const eventResponse = await handleEventPassive(text, senderJid, remoteJid);
    if (eventResponse) {
      await sock.sendMessage(remoteJid, { text: eventResponse }, { quoted: msg });
      return;
    }
  }

  // ── Emoji reactions to bot replies (acknowledgments) ──
  if (isReplyToBot(content, sock.user?.id, sock.user?.lid) && isAcknowledgment(text)) {
    logger.info({ remoteJid, sender: senderJid, text }, 'Acknowledgment reply — reacting');
    try {
      await sock.sendMessage(remoteJid, {
        react: { text: '🫘', key: msg.key },
      });
    } catch (err) {
      logger.error({ err }, 'Failed to send reaction');
    }
    return;
  }

  // ── Group messages ──
  if (isGroupJid(remoteJid)) {
    if (!isGroupEnabled(remoteJid)) return;

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
      return;
    }

    // Check for poll command — sends native WhatsApp poll instead of text
    if (featureCheck?.feature === 'poll' && isFeatureEnabled(remoteJid, 'poll')) {
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
      return;
    }

    // Check for character command — sends PDF document + text summary
    // Validates PDF fields internally; if incomplete, retries and deletes previous attempt
    if (featureCheck?.feature === 'character' && isFeatureEnabled(remoteJid, 'character')) {
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
      return;
    }

    // ── Voice command (!voice) — TTS reply ──
    if (featureCheck?.feature === 'voice' && isFeatureEnabled(remoteJid, 'voice')) {
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
      return;
    }

    // ── Media understanding (images, videos, stickers, GIFs) ──
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

    // ── URL context enrichment ──
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
    return;
  }

  // ── Direct messages ──
  // Only respond to owner DMs for now (Phase 1 safety)
  if (senderJid === config.OWNER_JID) {
    logger.info({ sender: senderJid, text }, 'Owner DM');
    recordOwnerDM();

    // Owner commands
    if (text.trim().toLowerCase() === '!catchup intros') {
      const result = await triggerIntroCatchUp(sock);
      await sock.sendMessage(remoteJid, { text: result });
      return;
    }

    if (text.trim().toLowerCase() === '!digest') {
      const digest = previewDigest();
      await sock.sendMessage(remoteJid, { text: digest });
      return;
    }

    if (text.trim().toLowerCase() === '!strikes') {
      const report = formatStrikesReport();
      await sock.sendMessage(remoteJid, { text: report });
      return;
    }

    if (text.trim().toLowerCase().startsWith('!feedback')) {
      const args = text.trim().slice('!feedback'.length).trim();
      const result = handleFeedbackOwner(args);
      await sock.sendMessage(remoteJid, { text: result });
      return;
    }

    if (text.trim().toLowerCase().startsWith('!release')) {
      const args = text.trim().slice('!release'.length).trim();
      const result = await handleRelease(args, sock);
      await sock.sendMessage(remoteJid, { text: result });
      return;
    }

    if (text.trim().toLowerCase().startsWith('!memory')) {
      const args = text.trim().slice('!memory'.length).trim();
      const result = handleMemory(args);
      await sock.sendMessage(remoteJid, { text: result });
      return;
    }

    // Owner help — show both regular + owner commands
    const lower = text.trim().toLowerCase();
    if (lower === '!help' || lower === '!help admin' || lower === '!admin') {
      const help = getHelpMessage() + '\n\n---\n\n' + getOwnerHelpMessage();
      await sock.sendMessage(remoteJid, { text: help });
      return;
    }

    const response = await getResponse(text, {
      groupName: 'DM',
      groupJid: remoteJid,
      senderJid,
    });

    if (response) {
      await sock.sendMessage(remoteJid, { text: response });
    }
  }
}

/**
 * Try feature-specific handlers first, then fall back to general AI.
 * Features are matched by keyword; if no feature matches, Claude handles it.
 */
async function getResponse(
  query: string,
  ctx: import('../ai/persona.js').MessageContext,
  visionImages?: VisionImage[],
): Promise<string | null> {
  const feature = matchFeature(query);

  if (feature && isFeatureEnabled(ctx.groupJid, feature.feature)) {
    logger.info({ feature: feature.feature }, 'Routing to feature handler');

    switch (feature.feature) {
      case 'help':
        return getHelpMessage();
      case 'weather':
        return await handleWeather(feature.query);
      case 'transit':
        return await handleTransit(feature.query);
      case 'news':
        return await handleNews(feature.query);
      case 'events':
        return await handleEvent(feature.query, ctx.senderJid, ctx.groupJid);
      case 'roll':
      case 'dnd':
        return await handleDnd(feature.query);
      case 'books':
        return await handleBooks(feature.query);
      case 'venues':
        return await handleVenues(feature.query);
      case 'poll':
        // Polls return string errors only — actual polls handled above
        return typeof handlePoll(feature.query) === 'string' ? handlePoll(feature.query) as string : null;
      case 'fun':
        return await handleFun(feature.query);
      case 'character': {
        // In getResponse (DM path), return text summary only — no PDF upload here
        const charResult = await handleCharacter(feature.query);
        return typeof charResult === 'string' ? charResult : charResult.summary;
      }
      case 'profile':
        return handleProfile(feature.query, ctx.senderJid);
      case 'summary':
        return await handleSummary(feature.query, ctx.groupJid, ctx.senderJid);
      case 'recommend':
        return await handleRecommendations(feature.query, ctx.senderJid, ctx.groupJid);
    }
  }

  // No feature matched — general AI response (with optional vision)
  return await getAIResponse(query, ctx, visionImages);
}

/** Extract text content from unwrapped message content */
function extractText(content: WAMessageContent | undefined): string | null {
  if (!content) return null;

  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    null
  );
}

/** Extract quoted/replied-to text if present */
function extractQuotedText(content: WAMessageContent | undefined): string | undefined {
  const quoted = content?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) return undefined;
  // The quoted message itself may need unwrapping
  const unwrapped = normalizeMessageContent(quoted);
  return extractText(unwrapped) ?? undefined;
}

/** Extract JIDs mentioned via WhatsApp's native @mention system */
function extractMentionedJids(content: WAMessageContent | undefined): string[] | undefined {
  if (!content) return undefined;
  const ctx = content.extendedTextMessage?.contextInfo
    ?? content.imageMessage?.contextInfo
    ?? content.videoMessage?.contextInfo
    ?? content.documentMessage?.contextInfo;
  const jids = ctx?.mentionedJid;
  if (!jids || jids.length === 0) return undefined;
  return jids;
}

/**
 * Check if a message is too old to process.
 * Prevents the bot from replying to stale mentions delivered after
 * an outage (e.g., "what's the weather?" asked 3 hours ago).
 */
function isStale(msg: WAMessage): boolean {
  const ts = msg.messageTimestamp;
  if (!ts) return false; // No timestamp — treat as fresh

  const epochSeconds = typeof ts === 'number' ? ts : Number(ts);
  const ageSeconds = Math.floor(Date.now() / 1000) - epochSeconds;

  if (ageSeconds > MAX_MESSAGE_AGE_SECONDS) {
    logger.debug({ ageSeconds, msgId: msg.key.id }, 'Ignoring stale message');
    return true;
  }
  return false;
}

// ── Acknowledgment reactions ────────────────────────────────────────

/** Extract the bare identifier from a JID (without device suffix or domain) */
function bareId(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

/**
 * Check if this message is a reply to one of the bot's messages.
 * Looks at contextInfo.participant (who sent the quoted message).
 */
function isReplyToBot(
  content: WAMessageContent | undefined,
  botJid?: string,
  botLid?: string,
): boolean {
  if (!content) return false;
  const ctx = content.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) return false;

  const quotedParticipant = ctx.participant;
  if (!quotedParticipant) return false;

  const botIds = [botJid, botLid].filter(Boolean).map((id) => bareId(id!));
  return botIds.includes(bareId(quotedParticipant));
}

/**
 * Short acknowledgment patterns that warrant an emoji reaction
 * instead of a full AI response. Matched case-insensitively.
 */
const ACKNOWLEDGMENT_PATTERNS = [
  /^good bot\b/i,
  /^bad bot\b/i,
  /^thanks?\b/i,
  /^thank you\b/i,
  /^ty\b/i,
  /^thx\b/i,
  /^nice\b/i,
  /^cool\b/i,
  /^awesome\b/i,
  /^great\b/i,
  /^perfect\b/i,
  /^👍/,
  /^❤️/,
  /^🙏/,
  /^😂/,
  /^lol\b/i,
  /^lmao\b/i,
  /^haha\b/i,
  /^ok\b/i,
  /^okay\b/i,
  /^bet\b/i,
  /^word\b/i,
  /^dope\b/i,
];

/** Check if a message is a short acknowledgment */
function isAcknowledgment(text: string): boolean {
  const trimmed = text.trim();
  // Must be short (under 30 chars) to be an acknowledgment
  if (trimmed.length > 30) return false;
  return ACKNOWLEDGMENT_PATTERNS.some((p) => p.test(trimmed));
}
