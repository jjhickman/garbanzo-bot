/**
 * Weekly community recap — aggregates the archived daily digests
 * (daily_stats snapshots written by the digest scheduler) plus today's
 * in-memory stats into one owner-facing summary.
 *
 * Deliberately number-based like the daily digest (no LLM call): the recap
 * must work even when every AI provider is down, and it costs nothing.
 */

import { logger } from '../middleware/logger.js';
import { getCurrentStats } from '../middleware/stats.js';
import { getGroupName } from '../core/groups-config.js';
import { loadDailyStatsRange } from '../utils/db.js';

interface ArchivedGroup {
  messageCount?: number;
  activeUsers?: string[];
  botResponses?: number;
  moderationFlags?: number;
  sessionSummariesCreated?: number;
}

interface ArchivedDay {
  date?: string;
  groups?: Record<string, ArchivedGroup>;
  ownerDMs?: number;
}

interface GroupAggregate {
  messages: number;
  botResponses: number;
  moderationFlags: number;
  activeUsers: Set<string>;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Build the weekly recap text covering the last 7 days (including today). */
export async function buildWeeklyRecap(now: Date = new Date()): Promise<string> {
  const from = new Date(now);
  from.setDate(from.getDate() - 6);
  const fromDate = isoDate(from);
  const toDate = isoDate(now);

  const groupTotals = new Map<string, GroupAggregate>();
  let ownerDMs = 0;
  let daysWithData = 0;

  const aggregate = (jid: string, g: ArchivedGroup): void => {
    let agg = groupTotals.get(jid);
    if (!agg) {
      agg = { messages: 0, botResponses: 0, moderationFlags: 0, activeUsers: new Set() };
      groupTotals.set(jid, agg);
    }
    agg.messages += g.messageCount ?? 0;
    agg.botResponses += g.botResponses ?? 0;
    agg.moderationFlags += g.moderationFlags ?? 0;
    for (const user of g.activeUsers ?? []) agg.activeUsers.add(user);
  };

  const archived = await loadDailyStatsRange(fromDate, toDate);
  const archivedDates = new Set<string>();
  for (const row of archived) {
    try {
      const day = JSON.parse(row.data) as ArchivedDay;
      archivedDates.add(row.date);
      daysWithData += 1;
      ownerDMs += day.ownerDMs ?? 0;
      for (const [jid, g] of Object.entries(day.groups ?? {})) aggregate(jid, g);
    } catch (err) {
      logger.warn({ err, date: row.date }, 'Skipping unparseable daily stats archive row');
    }
  }

  // Today's stats are archived only at digest time — merge the live counters
  // unless today has already been archived.
  const today = getCurrentStats();
  if (!archivedDates.has(today.date)) {
    if (today.groups.size > 0 || today.ownerDMs > 0) daysWithData += 1;
    ownerDMs += today.ownerDMs;
    for (const [jid, g] of today.groups) {
      aggregate(jid, {
        messageCount: g.messageCount,
        activeUsers: [...g.activeUsers],
        botResponses: g.botResponses,
        moderationFlags: g.moderationFlags,
      });
    }
  }

  if (groupTotals.size === 0) {
    return `🫘 *Weekly Recap — ${fromDate} → ${toDate}*\n\nNo recorded activity this week.`;
  }

  const sorted = [...groupTotals.entries()].sort((a, b) => b[1].messages - a[1].messages);

  let totalMessages = 0;
  let totalResponses = 0;
  let totalFlags = 0;
  const allUsers = new Set<string>();
  for (const [, agg] of sorted) {
    totalMessages += agg.messages;
    totalResponses += agg.botResponses;
    totalFlags += agg.moderationFlags;
    for (const user of agg.activeUsers) allUsers.add(user);
  }

  const lines: string[] = [
    `🫘 *Weekly Recap — ${fromDate} → ${toDate}*`,
    '',
    `📈 ${totalMessages.toLocaleString()} messages from ${allUsers.size} people across ${sorted.length} group${sorted.length !== 1 ? 's' : ''} (${daysWithData} day${daysWithData !== 1 ? 's' : ''} of data)`,
    `🤖 ${totalResponses.toLocaleString()} bot replies · 💬 ${ownerDMs} owner DMs${totalFlags > 0 ? ` · 🚩 ${totalFlags} moderation flag${totalFlags !== 1 ? 's' : ''}` : ''}`,
    '',
    '*Most active groups:*',
  ];

  for (const [jid, agg] of sorted.slice(0, 5)) {
    lines.push(`  • ${getGroupName(jid)} — ${agg.messages.toLocaleString()} msgs, ${agg.activeUsers.size} people, ${agg.botResponses} replies`);
  }

  const quiet = sorted.filter(([, agg]) => agg.messages === 0).length;
  if (quiet > 0) {
    lines.push('', `😴 ${quiet} group${quiet !== 1 ? 's' : ''} had no messages this week.`);
  }

  return lines.join('\n');
}
