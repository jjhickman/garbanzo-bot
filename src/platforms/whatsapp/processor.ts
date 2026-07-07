import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import { logger } from '../../middleware/logger.js';
import { markMessageReceived } from '../../middleware/health.js';
import { isVoiceMessage, downloadVoiceAudio } from './media.js';
import { transcribeAudio } from '../../features/voice.js';
import { handleIntroduction } from '../../features/introductions.js';
import { handleEventPassive } from '../../features/events.js';
import { config } from '../../utils/config.js';
import { isGroupEnabled, getEnabledGroupJidByName } from '../../core/groups-config.js';
import { handleOwnerDM } from './owner-commands.js';
import { handleGroupMessage } from './group-handler.js';
import { isReplyToBot, isAcknowledgment } from './reactions.js';
import { normalizeWhatsAppInboundMessage, type WhatsAppInbound } from './inbound.js';
import { createWhatsAppAdapter } from './adapter.js';
import { processInboundMessage } from '../../core/process-inbound-message.js';
import { getWhatsAppOutboundSafety } from './outbound-safety.js';
import { captureForBridge } from '../../bridge/capture-hook.js';

/**
 * WhatsApp platform processor.
 *
 * This runs WhatsApp-specific preprocessing (voice transcription) and then
 * delegates to the platform-agnostic core pipeline.
 */
export async function processWhatsAppRawMessage(sock: WASocket, msg: WAMessage): Promise<void> {
  // Track message freshness for staleness detection
  markMessageReceived();

  const inbound = normalizeWhatsAppInboundMessage(sock, msg);
  if (!inbound) return;
  getWhatsAppOutboundSafety(sock)?.onIncomingMessage(inbound.chatId, inbound.text ?? undefined);

  // Voice message transcription
  if (isVoiceMessage(msg)) {
    const audioBuffer = await downloadVoiceAudio(msg);
    if (!audioBuffer) return;

    const transcript = await transcribeAudio(audioBuffer, 'audio/ogg');
    if (!transcript) {
      logger.debug('Voice message transcription failed — skipping');
      return;
    }

    logger.info({ transcriptLen: transcript.length }, 'Voice message transcribed');
    inbound.text = transcript;
  }

  const adapter = createWhatsAppAdapter(sock);
  // Config schema requires OWNER_JID for the WhatsApp platform; this narrows
  // the conditional type at WhatsApp-only call sites.
  const ownerJid = config.OWNER_JID;
  if (!ownerJid) throw new Error('OWNER_JID is required for WhatsApp message processing');

  await processInboundMessage(adapter, inbound, {
    isReplyToBot: (m) => {
      const wa = m as WhatsAppInbound;
      return isReplyToBot(wa.content, sock.user?.id, sock.user?.lid);
    },

    isAcknowledgment: (t) => isAcknowledgment(t),

    sendAcknowledgmentReaction: async (m) => {
      const wa = m as WhatsAppInbound;
      await sock.sendMessage(wa.chatId, { react: { text: '🫘', key: wa.waMessage.key } });
    },

    handleGroupMessage: async ({ inbound: m, text, hasMedia }) => {
      const wa = m as WhatsAppInbound;
      await handleGroupMessage(sock, wa.waMessage, wa.chatId, wa.senderId, text, wa.content, hasMedia);
    },

    handleOwnerDM: async ({ inbound: m, text }) => {
      const wa = m as WhatsAppInbound;
      await handleOwnerDM(sock, wa.chatId, wa.senderId, text);
    },

    captureForBridge,
  }, {
    ownerId: ownerJid,
    isGroupEnabled,
    shouldIngestGroupChat: config.WHATSAPP_CHAT_SCOPE === 'configured' ? isGroupEnabled : undefined,
    introductionsChatId: getEnabledGroupJidByName('Introductions'),
    eventsChatId: getEnabledGroupJidByName('Events'),
    handleIntroduction,
    handleEventPassive,
  });
}
