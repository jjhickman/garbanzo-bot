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
import { jidsMatch } from '../../utils/jid.js';
import { getResponse } from '../../core/response-router.js';
import { getWhatsAppOutboundSafety } from './outbound-safety.js';
import { cancelEventReminder, listUpcomingEventReminders } from '../../utils/db.js';
import type { EventReminder } from '../../utils/db-types.js';

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

async function sendOwnerControlMessage(sock: WASocket, remoteJid: string, text: string): Promise<void> {
  const safety = getWhatsAppOutboundSafety(sock);
  if (safety) {
    await safety.sendControlText(remoteJid, text);
    return;
  }
  await sock.sendMessage(remoteJid, { text });
}

async function handleWhatsAppSafetyCommand(sock: WASocket, remoteJid: string, text: string): Promise<boolean> {
  const safety = getWhatsAppOutboundSafety(sock);
  if (!safety) {
    await sendOwnerControlMessage(sock, remoteJid, 'WhatsApp safety controls are unavailable on this socket.');
    return true;
  }

  const args = text.trim().slice('!whatsapp'.length).trim().toLowerCase();
  if (args === '' || args === 'status') {
    const metrics = await safety.metrics();
    await sendOwnerControlMessage(
      sock,
      remoteJid,
      [
        '*WhatsApp safety status*',
        `Output: ${metrics.paused ? 'paused' : 'active'}`,
        `Risk: ${metrics.risk} (${metrics.score})`,
        `Held: ${metrics.held} | Pending: ${metrics.pending}`,
        `Sent: ${metrics.sentLastHour} last hour | ${metrics.sentLastDay} last day`,
        `Failed: ${metrics.failedLastHour} last hour`,
      ].join('\n'),
    );
    return true;
  }

  if (args === 'pause') {
    await safety.pause();
    await sendOwnerControlMessage(sock, remoteJid, 'WhatsApp outbound sending paused. New output will be held for manual release.');
    return true;
  }

  if (args === 'resume') {
    await safety.resume();
    await sendOwnerControlMessage(sock, remoteJid, 'WhatsApp outbound sending resumed. Held output remains held until explicitly released.');
    return true;
  }

  if (args === 'held') {
    const held = await safety.heldJobs(10);
    const response = held.length === 0
      ? 'No held WhatsApp outbound jobs.'
      : ['*Held WhatsApp jobs*', ...held.map((job) => `#${job.id} ${job.kind}: ${job.reason ?? 'held'}`)].join('\n');
    await sendOwnerControlMessage(sock, remoteJid, response);
    return true;
  }

  const actionMatch = args.match(/^(release|discard)\s+(\d+)$/);
  if (actionMatch) {
    const id = Number.parseInt(actionMatch[2], 10);
    const success = actionMatch[1] === 'release'
      ? await safety.releaseHeldJob(id)
      : await safety.discardHeldJob(id);
    const verb = actionMatch[1] === 'release' ? 'released' : 'discarded';
    await sendOwnerControlMessage(
      sock,
      remoteJid,
      success ? `WhatsApp job #${id} ${verb}.` : `Unable to ${actionMatch[1]} WhatsApp job #${id}; it is not currently held.`,
    );
    return true;
  }

  await sendOwnerControlMessage(
    sock,
    remoteJid,
    'Usage: !whatsapp status | pause | resume | held | release <id> | discard <id>',
  );
  return true;
}

async function handleEventsOwnerCommand(sock: WASocket, remoteJid: string, text: string): Promise<boolean> {
  const args = text.trim().slice('!events'.length).trim();
  const cancelMatch = args.match(/^cancel\s+(\d+)$/i);

  if (cancelMatch) {
    const id = Number.parseInt(cancelMatch[1], 10);
    const cancelled = await cancelEventReminder(id);
    await sendOwnerControlMessage(
      sock,
      remoteJid,
      cancelled ? `Event reminder #${id} cancelled.` : `Unable to cancel event reminder #${id}; it may not be pending.`,
    );
    return true;
  }

  if (args.length > 0) {
    await sendOwnerControlMessage(sock, remoteJid, 'Usage: !events | !events cancel <id>');
    return true;
  }

  const reminders = await listUpcomingEventReminders(10);
  await sendOwnerControlMessage(sock, remoteJid, formatUpcomingEventReminders(reminders));
  return true;
}

function formatUpcomingEventReminders(reminders: EventReminder[]): string {
  if (reminders.length === 0) {
    return 'No pending event reminders.';
  }

  return [
    '*Upcoming event reminders*',
    ...reminders.map((reminder) => {
      const when = new Date(reminder.eventAt * 1000).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      return `#${reminder.id} ${reminder.activity} — ${when}${reminder.location ? ` at ${reminder.location}` : ''} — !events cancel ${reminder.id}`;
    }),
  ].join('\n');
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
  if (!jidsMatch(senderJid, config.OWNER_JID)) return false;

  logger.info({ sender: senderJid, text }, 'Owner DM');
  recordOwnerDM();

  const trimmedLower = text.trim().toLowerCase();

  if (trimmedLower.startsWith('!whatsapp')) {
    return handleWhatsAppSafetyCommand(sock, remoteJid, text);
  }

  if (trimmedLower.startsWith('!events')) {
    return handleEventsOwnerCommand(sock, remoteJid, text);
  }

  // !catchup intros
  if (trimmedLower === '!catchup intros') {
    const result = await triggerIntroCatchUp(sock);
    await sock.sendMessage(remoteJid, { text: result });
    return true;
  }

  // !recap — weekly community recap (lazy import: recap pulls the db layer,
  // which command tests mock per-module)
  if (trimmedLower === '!recap') {
    const { buildWeeklyRecap } = await import('../../features/recap.js');
    const recap = await buildWeeklyRecap();
    await sock.sendMessage(remoteJid, { text: recap });
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
    await sendOwnerControlMessage(sock, remoteJid, result);
    return true;
  }

  // !support [broadcast]
  if (trimmedLower.startsWith('!support')) {
    const args = text.trim().slice('!support'.length).trim().toLowerCase();
    const supportMessage = buildSupportMessage();

    if (args === 'broadcast') {
      const result = await broadcastSupportMessage(sock, supportMessage);
      await sendOwnerControlMessage(sock, remoteJid, `${supportMessage}\n\n---\n\n${result}`);
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
