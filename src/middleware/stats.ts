/**
 * Daily statistics tracker — in-memory counters that reset at midnight.
 *
 * Tracks per-group message counts, active users, AI routing decisions,
 * and moderation flags. Used by the daily digest feature.
 */

import { logger } from './logger.js';

export interface GroupStats {
  messageCount: number;
  activeUsers: Set<string>;
  botResponses: number;
  ollamaRouted: number;
  claudeRouted: number;
  moderationFlags: number;
}

export interface DailyStats {
  /** ISO date string (YYYY-MM-DD) for this stats period */
  date: string;
  /** Per-group stats keyed by group JID */
  groups: Map<string, GroupStats>;
  /** Total DM messages from owner */
  ownerDMs: number;
}

let current: DailyStats = freshStats();

function freshStats(): DailyStats {
  return {
    date: todayISO(),
    groups: new Map(),
    ownerDMs: 0,
  };
}

function todayISO(): string {
  // Use local timezone (EST/EDT on Terra)
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function getGroupStats(groupJid: string): GroupStats {
  let stats = current.groups.get(groupJid);
  if (!stats) {
    stats = {
      messageCount: 0,
      activeUsers: new Set(),
      botResponses: 0,
      ollamaRouted: 0,
      claudeRouted: 0,
      moderationFlags: 0,
    };
    current.groups.set(groupJid, stats);
  }
  return stats;
}

/** Roll over to a new day if needed. Returns the old stats if rolled. */
function maybeRollover(): DailyStats | null {
  const today = todayISO();
  if (current.date !== today) {
    const old = current;
    current = freshStats();
    logger.info({ oldDate: old.date, newDate: today }, 'Daily stats rolled over');
    return old;
  }
  return null;
}

// ── Public recording functions ──────────────────────────────────────

export function recordGroupMessage(groupJid: string, senderJid: string): void {
  maybeRollover();
  const stats = getGroupStats(groupJid);
  stats.messageCount++;
  stats.activeUsers.add(senderJid.split('@')[0].split(':')[0]);
}

export function recordBotResponse(groupJid: string): void {
  maybeRollover();
  getGroupStats(groupJid).botResponses++;
}

export function recordAIRoute(groupJid: string, model: 'ollama' | 'claude'): void {
  maybeRollover();
  const stats = getGroupStats(groupJid);
  if (model === 'ollama') stats.ollamaRouted++;
  else stats.claudeRouted++;
}

export function recordModerationFlag(groupJid: string): void {
  maybeRollover();
  getGroupStats(groupJid).moderationFlags++;
}

export function recordOwnerDM(): void {
  maybeRollover();
  current.ownerDMs++;
}

// ── Public query functions ──────────────────────────────────────────

/** Get current day's stats (triggers rollover if needed) */
export function getCurrentStats(): DailyStats {
  maybeRollover();
  return current;
}

/** Snapshot and reset — used by digest to get final stats for the day */
export function snapshotAndReset(): DailyStats {
  const snapshot = current;
  current = freshStats();
  return snapshot;
}
