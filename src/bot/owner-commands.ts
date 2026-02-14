import type { WASocket } from '@whiskeysockets/baileys';
import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { getHelpMessage, getOwnerHelpMessage } from '../features/help.js';
import { triggerIntroCatchUp } from '../features/introductions.js';
import { previewDigest } from '../features/digest.js';
import { formatStrikesReport } from '../features/moderation.js';
import { handleFeedbackOwner } from '../features/feedback.js';
import { handleRelease } from '../features/release.js';
import { handleMemory } from '../features/memory.js';
import { recordOwnerDM } from '../middleware/stats.js';
import { getResponse } from './handlers.js';

/**
 * Handle a direct message from the bot owner.
 * Routes owner-only commands (!catchup intros, !digest, !strikes, etc.)
 * and falls back to general AI for unrecognized messages.
 *
 * @returns true if the message was handled as an owner DM, false otherwise
 */
export async function handleOwnerDM(
  sock: WASocket,
  remoteJid: string,
  senderJid: string,
  text: string,
): Promise<boolean> {
  if (senderJid !== config.OWNER_JID) return false;

  logger.info({ sender: senderJid, text }, 'Owner DM');
  recordOwnerDM();

  const trimmedLower = text.trim().toLowerCase();

  // !catchup intros
  if (trimmedLower === '!catchup intros') {
    const result = await triggerIntroCatchUp(sock);
    await sock.sendMessage(remoteJid, { text: result });
    return true;
  }

  // !digest
  if (trimmedLower === '!digest') {
    const digest = previewDigest();
    await sock.sendMessage(remoteJid, { text: digest });
    return true;
  }

  // !strikes
  if (trimmedLower === '!strikes') {
    const report = formatStrikesReport();
    await sock.sendMessage(remoteJid, { text: report });
    return true;
  }

  // !feedback [args]
  if (trimmedLower.startsWith('!feedback')) {
    const args = text.trim().slice('!feedback'.length).trim();
    const result = handleFeedbackOwner(args);
    await sock.sendMessage(remoteJid, { text: result });
    return true;
  }

  // !release [args]
  if (trimmedLower.startsWith('!release')) {
    const args = text.trim().slice('!release'.length).trim();
    const result = await handleRelease(args, sock);
    await sock.sendMessage(remoteJid, { text: result });
    return true;
  }

  // !memory [args]
  if (trimmedLower.startsWith('!memory')) {
    const args = text.trim().slice('!memory'.length).trim();
    const result = handleMemory(args);
    await sock.sendMessage(remoteJid, { text: result });
    return true;
  }

  // Owner help — show both regular + owner commands
  if (trimmedLower === '!help' || trimmedLower === '!help admin' || trimmedLower === '!admin') {
    const help = getHelpMessage() + '\n\n---\n\n' + getOwnerHelpMessage();
    await sock.sendMessage(remoteJid, { text: help });
    return true;
  }

  // No specific command — general AI response
  const response = await getResponse(text, {
    groupName: 'DM',
    groupJid: remoteJid,
    senderJid,
  });

  if (response) {
    await sock.sendMessage(remoteJid, { text: response });
  }

  return true;
}
