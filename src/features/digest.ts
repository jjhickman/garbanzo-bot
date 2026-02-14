/**
 * Daily digest — sends a summary of group activity to the owner's DM at 9 PM.
 *
 * Uses stats from the middleware/stats tracker. Scheduled via setTimeout
 * (no cron dependency). Reschedules itself after each run.
 */

import type { WASocket } from '@whiskeysockets/baileys';
import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { getCurrentStats, snapshotAndReset, type DailyStats } from '../middleware/stats.js';
import { getGroupName } from '../bot/groups.js';
import { saveDailyStats } from '../utils/db.js';

const DIGEST_HOUR = 21; // 9 PM local time

/**
 * Schedule the daily digest. Call once at startup.
 * Automatically reschedules after each digest send.
 */
export function scheduleDigest(sock: WASocket): void {
  const msUntilDigest = msUntilHour(DIGEST_HOUR);
  const hoursUntil = Math.round(msUntilDigest / 1000 / 60 / 60 * 10) / 10;

  logger.info({ nextDigestIn: `${hoursUntil}h`, targetHour: DIGEST_HOUR }, 'Daily digest scheduled');

  setTimeout(async () => {
    try {
      await sendDigest(sock);
    } catch (err) {
      logger.error({ err }, 'Failed to send daily digest');
    }
    // Reschedule for tomorrow
    scheduleDigest(sock);
  }, msUntilDigest);
}

/**
 * Send the daily digest to the owner's DM.
 * Also available as `!digest` owner command.
 */
export async function sendDigest(sock: WASocket): Promise<string> {
  const stats = snapshotAndReset();
  const text = formatDigest(stats);

  // Archive to SQLite
  try {
    const archiveData = serializeStats(stats);
    saveDailyStats(stats.date, archiveData);
  } catch (err) {
    logger.error({ err }, 'Failed to archive daily stats');
  }

  try {
    await sock.sendMessage(config.OWNER_JID, { text });
    logger.info({ date: stats.date }, 'Daily digest sent');
  } catch (err) {
    logger.error({ err }, 'Failed to send digest to owner DM');
  }

  return text;
}

/**
 * Generate a digest for the current (partial) day without resetting.
 * Used by `!digest` command to preview stats so far.
 */
export function previewDigest(): string {
  return formatDigest(getCurrentStats());
}

function formatDigest(stats: DailyStats): string {
  const lines: string[] = [
    `🫘 *Daily Digest — ${stats.date}*`,
    '',
  ];

  let totalMessages = 0;
  let totalUsers = 0;
  let totalBotResponses = 0;
  let totalOllama = 0;
  let totalClaude = 0;
  let totalFlags = 0;

  // Sort groups by message count (most active first)
  const sorted = [...stats.groups.entries()].sort(
    (a, b) => b[1].messageCount - a[1].messageCount,
  );

  if (sorted.length === 0) {
    lines.push('_No group activity recorded today._');
  } else {
    lines.push('*Group Activity:*');
    for (const [jid, g] of sorted) {
      const name = getGroupName(jid);
      const userCount = g.activeUsers.size;
      lines.push(`• *${name}* — ${g.messageCount} msgs, ${userCount} active users`);
      if (g.botResponses > 0) {
        lines.push(`  ↳ ${g.botResponses} bot responses (${g.ollamaRouted} Ollama, ${g.claudeRouted} Claude)`);
      }
      if (g.moderationFlags > 0) {
        lines.push(`  ⚠️ ${g.moderationFlags} moderation flags`);
      }
      totalMessages += g.messageCount;
      totalUsers += userCount;
      totalBotResponses += g.botResponses;
      totalOllama += g.ollamaRouted;
      totalClaude += g.claudeRouted;
      totalFlags += g.moderationFlags;
    }
  }

  lines.push('');
  lines.push('*Totals:*');
  lines.push(`• ${totalMessages} messages across ${sorted.length} groups`);
  lines.push(`• ${totalUsers} unique active users`);

  if (totalBotResponses > 0) {
    const ollamaPct = totalBotResponses > 0
      ? Math.round((totalOllama / (totalOllama + totalClaude)) * 100)
      : 0;
    lines.push(`• ${totalBotResponses} bot responses (${ollamaPct}% Ollama, ${100 - ollamaPct}% Claude)`);
  }

  if (totalFlags > 0) {
    lines.push(`• ⚠️ ${totalFlags} moderation flags`);
  }

  if (stats.ownerDMs > 0) {
    lines.push(`• ${stats.ownerDMs} owner DM interactions`);
  }

  return lines.join('\n');
}

/** Serialize DailyStats to JSON (convert Sets to arrays) */
function serializeStats(stats: DailyStats): string {
  const groups: Record<string, object> = {};
  for (const [jid, g] of stats.groups) {
    groups[jid] = {
      messageCount: g.messageCount,
      activeUsers: [...g.activeUsers],
      botResponses: g.botResponses,
      ollamaRouted: g.ollamaRouted,
      claudeRouted: g.claudeRouted,
      moderationFlags: g.moderationFlags,
    };
  }
  return JSON.stringify({ date: stats.date, groups, ownerDMs: stats.ownerDMs });
}

/** Calculate milliseconds from now until the next occurrence of a given hour */
function msUntilHour(hour: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);

  // If we've already passed this hour today, schedule for tomorrow
  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime() - now.getTime();
}
