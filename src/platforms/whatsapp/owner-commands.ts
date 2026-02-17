import type { WASocket } from '@whiskeysockets/baileys';

import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import { getHelpMessage, getOwnerHelpMessage } from '../../features/help.js';
import { triggerIntroCatchUp } from './introductions-catchup.js';
import { previewDigest } from '../../features/digest.js';
import { formatStrikesReport } from '../../features/moderation.js';
import { handleFeedbackOwner, createGitHubIssueFromFeedback } from '../../features/feedback.js';
import { handleRelease } from '../../features/release.js';
import { handleMemory } from '../../features/memory.js';
import { recordOwnerDM } from '../../middleware/stats.js';
import { GROUP_IDS, isFeatureEnabled } from '../../core/groups-config.js';
import { getResponse } from '../../core/response-router.js';

function buildSupportMessage(): string {
  const lines: string[] = [
    '❤️ *Support Garbanzo*',
    '',
    config.SUPPORT_MESSAGE
      ?? 'If Garbanzo helps your community, you can support ongoing development and hosting costs:',
  ];

  const links: Array<{ label: string; url?: string }> = [
    { label: 'GitHub Sponsors', url: config.GITHUB_SPONSORS_URL },
    { label: 'Patreon', url: config.PATREON_URL },
    { label: 'Ko-fi', url: config.KOFI_URL },
    { label: 'Support Link', url: config.SUPPORT_CUSTOM_URL },
  ];

  const activeLinks = links.filter((entry) => !!entry.url);
  if (activeLinks.length === 0) {
    lines.push('⚠️ No support links configured yet.');
    lines.push('Add any of: `GITHUB_SPONSORS_URL`, `PATREON_URL`, `KOFI_URL`, `SUPPORT_CUSTOM_URL` to `.env`.');
    return lines.join('\n');
  }

  lines.push('');
  for (const entry of activeLinks) {
    lines.push(`• ${entry.label}: ${entry.url}`);
  }
  lines.push('');
  lines.push('Thanks for helping keep Garbanzo useful, reliable, and actively maintained. 🫘');
  return lines.join('\n');
}

async function broadcastSupportMessage(sock: WASocket, text: string): Promise<string> {
  const targets = Object.entries(GROUP_IDS)
    .filter(([, group]) => group.enabled)
    .map(([jid]) => jid);

  if (targets.length === 0) {
    return '⚠️ No enabled groups found to broadcast support message.';
  }

  let sent = 0;
  let failed = 0;
  for (const jid of targets) {
    try {
      await sock.sendMessage(jid, { text });
      sent += 1;
    } catch (err) {
      failed += 1;
      logger.error({ err, jid }, 'Failed to send support message');
    }
  }

  return `✅ Support message sent to ${sent} group${sent !== 1 ? 's' : ''}${failed > 0 ? ` (${failed} failed)` : ''}.`;
}

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
    const digest = await previewDigest();
    await sock.sendMessage(remoteJid, { text: digest });
    return true;
  }

  // !strikes
  if (trimmedLower === '!strikes') {
    const report = await formatStrikesReport();
    await sock.sendMessage(remoteJid, { text: report });
    return true;
  }

  // !feedback [args]
  if (trimmedLower.startsWith('!feedback')) {
    const args = text.trim().slice('!feedback'.length).trim();

    const issueMatch = args.match(/^issue\s+(\d+)$/i);
    if (issueMatch) {
      const id = Number.parseInt(issueMatch[1], 10);
      const result = await createGitHubIssueFromFeedback(id);
      await sock.sendMessage(remoteJid, { text: result });
      return true;
    }

    const result = await handleFeedbackOwner(args);
    await sock.sendMessage(remoteJid, { text: result });
    return true;
  }

  // !release [args]
  if (trimmedLower.startsWith('!release')) {
    const args = text.trim().slice('!release'.length).trim();
    const result = await handleRelease(args, async (jid, t) => {
      await sock.sendMessage(jid, { text: t });
    });
    await sock.sendMessage(remoteJid, { text: result });
    return true;
  }

  // !support [broadcast]
  if (trimmedLower.startsWith('!support')) {
    const args = text.trim().slice('!support'.length).trim().toLowerCase();
    const supportMessage = buildSupportMessage();

    if (args === 'broadcast') {
      const result = await broadcastSupportMessage(sock, supportMessage);
      await sock.sendMessage(remoteJid, { text: `${supportMessage}\n\n---\n\n${result}` });
      return true;
    }

    await sock.sendMessage(remoteJid, { text: supportMessage });
    return true;
  }

  // !memory [args]
  if (trimmedLower.startsWith('!memory')) {
    const args = text.trim().slice('!memory'.length).trim();
    const result = await handleMemory(args);
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
  }, isFeatureEnabled);

  if (response) {
    await sock.sendMessage(remoteJid, { text: response });
  }

  return true;
}
