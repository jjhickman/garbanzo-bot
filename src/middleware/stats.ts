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
  openaiRouted: number;
  moderationFlags: number;
  aiErrors: number;
}

/** Per-call cost entry for tracking spend */
export interface CostEntry {
  model: 'claude' | 'openai' | 'ollama';
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number; // USD
  latencyMs: number;
}

export interface DailyStats {
  /** ISO date string (YYYY-MM-DD) for this stats period */
  date: string;
  /** Per-group stats keyed by group JID */
  groups: Map<string, GroupStats>;
  /** Total DM messages from owner */
  ownerDMs: number;
  /** AI cost tracking for the day */
  costs: CostEntry[];
  /** Running total estimated spend (USD) */
  totalCost: number;
}

let current: DailyStats = freshStats();

function freshStats(): DailyStats {
  return {
    date: todayISO(),
    groups: new Map(),
    ownerDMs: 0,
    costs: [],
    totalCost: 0,
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
      openaiRouted: 0,
      moderationFlags: 0,
      aiErrors: 0,
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

/** Record a user message for per-group volume and active-user tracking. */
export function recordGroupMessage(groupJid: string, senderJid: string): void {
  maybeRollover();
  const stats = getGroupStats(groupJid);
  stats.messageCount++;
  stats.activeUsers.add(senderJid.split('@')[0].split(':')[0]);
}

/** Record that the bot sent a response in a group. */
export function recordBotResponse(groupJid: string): void {
  maybeRollover();
  getGroupStats(groupJid).botResponses++;
}

/** Record which AI route handled a group response (Ollama/Claude/OpenAI). */
export function recordAIRoute(groupJid: string, model: 'ollama' | 'claude' | 'openai'): void {
  maybeRollover();
  const stats = getGroupStats(groupJid);
  if (model === 'ollama') stats.ollamaRouted++;
  else if (model === 'openai') stats.openaiRouted++;
  else stats.claudeRouted++;
}

/** Record that a moderation flag was raised in a group. */
export function recordModerationFlag(groupJid: string): void {
  maybeRollover();
  getGroupStats(groupJid).moderationFlags++;
}

/** Record an owner DM interaction. */
export function recordOwnerDM(): void {
  maybeRollover();
  current.ownerDMs++;
}

/** Record an AI processing error for a group. */
export function recordAIError(groupJid: string): void {
  maybeRollover();
  getGroupStats(groupJid).aiErrors++;
}

// ── Cost tracking ───────────────────────────────────────────────────

/**
 * Approximate token count from text.
 * Uses the ~4 chars per token heuristic for English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Claude Sonnet 4 pricing (OpenRouter) — USD per million tokens */
const CLAUDE_PRICING = {
  input: 3.0 / 1_000_000,
  output: 15.0 / 1_000_000,
};

/** OpenAI GPT-4.1 pricing — USD per million tokens */
const OPENAI_PRICING = {
  input: 2.0 / 1_000_000,
  output: 8.0 / 1_000_000,
};

/**
 * Record an AI call's cost. Call after each Claude response.
 * Ollama calls are free but tracked for latency stats.
 */
export function recordAICost(entry: CostEntry): void {
  maybeRollover();
  current.costs.push(entry);
  current.totalCost += entry.estimatedCost;
}

/** Estimate cost of a Claude call from prompt + response text */
export function estimateClaudeCost(
  systemPrompt: string,
  userMessage: string,
  response: string,
): CostEntry {
  const inputTokens = estimateTokens(systemPrompt) + estimateTokens(userMessage);
  const outputTokens = estimateTokens(response);
  return {
    model: 'claude',
    inputTokens,
    outputTokens,
    estimatedCost: (inputTokens * CLAUDE_PRICING.input) + (outputTokens * CLAUDE_PRICING.output),
    latencyMs: 0, // caller fills this in
  };
}

/** Estimate cost of an OpenAI call from prompt + response text */
export function estimateOpenAICost(
  systemPrompt: string,
  userMessage: string,
  response: string,
): CostEntry {
  const inputTokens = estimateTokens(systemPrompt) + estimateTokens(userMessage);
  const outputTokens = estimateTokens(response);
  return {
    model: 'openai',
    inputTokens,
    outputTokens,
    estimatedCost: (inputTokens * OPENAI_PRICING.input) + (outputTokens * OPENAI_PRICING.output),
    latencyMs: 0,
  };
}

/** Get today's estimated spend */
export function getDailyCost(): number {
  maybeRollover();
  return current.totalCost;
}

/** Daily cost alert threshold (USD) */
export const DAILY_COST_ALERT_THRESHOLD = 1.00;

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
