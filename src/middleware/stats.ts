/**
 * Daily statistics tracker — in-memory counters that reset at midnight.
 *
 * Tracks per-group message counts, active users, AI routing decisions,
 * and moderation flags. Used by the daily digest feature.
 */

import { logger } from './logger.js';
import { config } from '../utils/config.js';

export interface GroupStats {
  messageCount: number;
  activeUsers: Set<string>;
  botResponses: number;
  ollamaRouted: number;
  claudeRouted: number;
  openaiRouted: number;
  geminiRouted: number;
  bedrockRouted: number;
  moderationFlags: number;
  aiErrors: number;
  sessionSummariesCreated: number;
  sessionSummariesSkipped: number;
  sessionSummariesFailed: number;
  sessionSummaryRetrievalHits: number;
  sessionSummaryInjectedChars: number;
  sessionEmbeddingsDeterministic: number;
  sessionEmbeddingsOpenai: number;
  sessionEmbeddingFallbacks: number;
  sessionEmbeddingLatencyMs: number;
}

/** Per-call cost entry for tracking spend */
export interface CostEntry {
  model: 'claude' | 'openai' | 'gemini' | 'bedrock' | 'ollama';
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number; // USD
  latencyMs: number;
}

type AiProvider = CostEntry['model'];
type ToolCallOutcome = 'ok' | 'error';

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

export interface VectorStats {
  vectorUpsertsOk: number;
  vectorUpsertFailures: number;
  vectorSearchesOk: number;
  vectorSearchFailures: number;
}

export type StatsSnapshot = DailyStats & VectorStats;

export interface LifetimeCounters {
  messagesByGroupJid: ReadonlyMap<string, number>;
  botResponsesByGroupJid: ReadonlyMap<string, number>;
  aiRequestsByProvider: ReadonlyMap<AiProvider, number>;
  aiErrorsByGroupJid: ReadonlyMap<string, number>;
  moderationFlagsByGroupJid: ReadonlyMap<string, number>;
  ownerDmsTotal: number;
  aiCostUsdByProvider: ReadonlyMap<AiProvider, number>;
  rateLimitedTotal: number;
  toolCalls: ReadonlyMap<string, Readonly<Record<ToolCallOutcome, number>>>;
  eventRemindersSentTotal: number;
}

let current: StatsSnapshot = freshStats();

const lifetime = {
  messagesByGroupJid: new Map<string, number>(),
  botResponsesByGroupJid: new Map<string, number>(),
  aiRequestsByProvider: new Map<AiProvider, number>(),
  aiErrorsByGroupJid: new Map<string, number>(),
  moderationFlagsByGroupJid: new Map<string, number>(),
  ownerDmsTotal: 0,
  aiCostUsdByProvider: new Map<AiProvider, number>(),
  rateLimitedTotal: 0,
  toolCalls: new Map<string, Record<ToolCallOutcome, number>>(),
  eventRemindersSentTotal: 0,
};

function freshStats(): StatsSnapshot {
  return {
    date: todayISO(),
    groups: new Map(),
    ownerDMs: 0,
    costs: [],
    totalCost: 0,
    vectorUpsertsOk: 0,
    vectorUpsertFailures: 0,
    vectorSearchesOk: 0,
    vectorSearchFailures: 0,
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
      geminiRouted: 0,
      bedrockRouted: 0,
      moderationFlags: 0,
      aiErrors: 0,
      sessionSummariesCreated: 0,
      sessionSummariesSkipped: 0,
      sessionSummariesFailed: 0,
      sessionSummaryRetrievalHits: 0,
      sessionSummaryInjectedChars: 0,
      sessionEmbeddingsDeterministic: 0,
      sessionEmbeddingsOpenai: 0,
      sessionEmbeddingFallbacks: 0,
      sessionEmbeddingLatencyMs: 0,
    };
    current.groups.set(groupJid, stats);
  }
  return stats;
}

function incrementCounter<K>(counters: Map<K, number>, key: K, amount: number = 1): void {
  counters.set(key, (counters.get(key) ?? 0) + amount);
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
  incrementCounter(lifetime.messagesByGroupJid, groupJid);
  const stats = getGroupStats(groupJid);
  stats.messageCount++;
  stats.activeUsers.add(senderJid.split('@')[0].split(':')[0]);
}

/** Record that the bot sent a response in a group. */
export function recordBotResponse(groupJid: string): void {
  maybeRollover();
  incrementCounter(lifetime.botResponsesByGroupJid, groupJid);
  getGroupStats(groupJid).botResponses++;
}

/** Record which AI route handled a group response (Ollama/Claude/OpenAI/Gemini). */
export function recordAIRoute(groupJid: string, model: 'ollama' | 'claude' | 'openai' | 'gemini' | 'bedrock'): void {
  maybeRollover();
  incrementCounter(lifetime.aiRequestsByProvider, model);
  const stats = getGroupStats(groupJid);
  if (model === 'ollama') stats.ollamaRouted++;
  else if (model === 'openai') stats.openaiRouted++;
  else if (model === 'gemini') stats.geminiRouted++;
  else if (model === 'bedrock') stats.bedrockRouted++;
  else stats.claudeRouted++;
}

/** Record that a moderation flag was raised in a group. */
export function recordModerationFlag(groupJid: string): void {
  maybeRollover();
  incrementCounter(lifetime.moderationFlagsByGroupJid, groupJid);
  getGroupStats(groupJid).moderationFlags++;
}

/** Record an owner DM interaction. */
export function recordOwnerDM(): void {
  maybeRollover();
  lifetime.ownerDmsTotal++;
  current.ownerDMs++;
}

/** Record an AI processing error for a group. */
export function recordAIError(groupJid: string): void {
  maybeRollover();
  incrementCounter(lifetime.aiErrorsByGroupJid, groupJid);
  getGroupStats(groupJid).aiErrors++;
}

/** Record that a bot response was rejected by rate limiting. */
export function recordRateLimited(): void {
  lifetime.rateLimitedTotal++;
}

/** Record a tool call result. */
export function recordToolCall(tool: string, outcome: ToolCallOutcome): void {
  const calls = lifetime.toolCalls.get(tool) ?? { ok: 0, error: 0 };
  calls[outcome]++;
  lifetime.toolCalls.set(tool, calls);
}

/** Record a successfully sent event reminder. */
export function recordEventReminderSent(): void {
  lifetime.eventRemindersSentTotal++;
}

export function recordSessionSummaryLifecycle(
  groupJid: string,
  outcome: 'created' | 'skipped' | 'failed',
): void {
  maybeRollover();
  const stats = getGroupStats(groupJid);
  if (outcome === 'created') stats.sessionSummariesCreated++;
  else if (outcome === 'skipped') stats.sessionSummariesSkipped++;
  else stats.sessionSummariesFailed++;
}

export function recordSessionSummaryRetrieval(
  groupJid: string,
  hitCount: number,
  injectedChars: number,
): void {
  maybeRollover();
  const stats = getGroupStats(groupJid);
  stats.sessionSummaryRetrievalHits += Math.max(0, hitCount);
  stats.sessionSummaryInjectedChars += Math.max(0, injectedChars);
}

export function recordSessionEmbedding(
  groupJid: string,
  provider: 'deterministic' | 'openai',
  latencyMs: number,
  usedFallback: boolean,
): void {
  maybeRollover();
  const stats = getGroupStats(groupJid);
  if (provider === 'openai') stats.sessionEmbeddingsOpenai += 1;
  else stats.sessionEmbeddingsDeterministic += 1;
  if (usedFallback) stats.sessionEmbeddingFallbacks += 1;
  stats.sessionEmbeddingLatencyMs += Math.max(0, Math.round(latencyMs));
}

export function recordVectorUpsert(outcome: 'ok' | 'error'): void {
  maybeRollover();
  if (outcome === 'ok') current.vectorUpsertsOk++;
  else current.vectorUpsertFailures++;
}

export function recordVectorSearch(outcome: 'ok' | 'empty' | 'error'): void {
  maybeRollover();
  if (outcome === 'error') current.vectorSearchFailures++;
  else current.vectorSearchesOk++;
}

// ── Cost tracking ───────────────────────────────────────────────────

/**
 * Approximate token count from text.
 * Uses the ~4 chars per token heuristic for English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Anthropic pricing — env-configurable, USD per million tokens (default: Claude Haiku 4.5 $1/$5). */
const CLAUDE_PRICING = {
  input: (config.ANTHROPIC_PRICING_INPUT_PER_M ?? 0) / 1_000_000,
  output: (config.ANTHROPIC_PRICING_OUTPUT_PER_M ?? 0) / 1_000_000,
};

/** OpenAI pricing — env-configurable, USD per million tokens (default: gpt-5.4-mini $0.75/$4.50). */
const OPENAI_PRICING = {
  input: (config.OPENAI_PRICING_INPUT_PER_M ?? 0) / 1_000_000,
  output: (config.OPENAI_PRICING_OUTPUT_PER_M ?? 0) / 1_000_000,
};

/**
 * Gemini pricing varies by model and plan.
 *
 * We default to 0 so cost tracking remains conservative until we add
 * per-model pricing or configurable pricing in env.
 */
const GEMINI_PRICING = {
  input: (config.GEMINI_PRICING_INPUT_PER_M ?? 0) / 1_000_000,
  output: (config.GEMINI_PRICING_OUTPUT_PER_M ?? 0) / 1_000_000,
};

/** Bedrock pricing is model-dependent; defaults to 0 until configured. */
const BEDROCK_PRICING = {
  input: (config.BEDROCK_PRICING_INPUT_PER_M ?? 0) / 1_000_000,
  output: (config.BEDROCK_PRICING_OUTPUT_PER_M ?? 0) / 1_000_000,
};

/**
 * Record an AI call's cost. Call after each Claude response.
 * Ollama calls are free but tracked for latency stats.
 */
export function recordAICost(entry: CostEntry): void {
  maybeRollover();
  incrementCounter(lifetime.aiCostUsdByProvider, entry.model, entry.estimatedCost);
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

/** Estimate cost of a Gemini call from prompt + response text */
export function estimateGeminiCost(
  systemPrompt: string,
  userMessage: string,
  response: string,
): CostEntry {
  const inputTokens = estimateTokens(systemPrompt) + estimateTokens(userMessage);
  const outputTokens = estimateTokens(response);
  return {
    model: 'gemini',
    inputTokens,
    outputTokens,
    estimatedCost: (inputTokens * GEMINI_PRICING.input) + (outputTokens * GEMINI_PRICING.output),
    latencyMs: 0,
  };
}

/** Estimate cost of a Bedrock call from prompt + response text */
export function estimateBedrockCost(
  systemPrompt: string,
  userMessage: string,
  response: string,
): CostEntry {
  const inputTokens = estimateTokens(systemPrompt) + estimateTokens(userMessage);
  const outputTokens = estimateTokens(response);
  return {
    model: 'bedrock',
    inputTokens,
    outputTokens,
    estimatedCost: (inputTokens * BEDROCK_PRICING.input) + (outputTokens * BEDROCK_PRICING.output),
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
export function getCurrentStats(): StatsSnapshot {
  maybeRollover();
  return current;
}

/** Get process-lifetime Prometheus counters. */
export function getLifetimeCounters(): LifetimeCounters {
  return {
    messagesByGroupJid: new Map(lifetime.messagesByGroupJid),
    botResponsesByGroupJid: new Map(lifetime.botResponsesByGroupJid),
    aiRequestsByProvider: new Map(lifetime.aiRequestsByProvider),
    aiErrorsByGroupJid: new Map(lifetime.aiErrorsByGroupJid),
    moderationFlagsByGroupJid: new Map(lifetime.moderationFlagsByGroupJid),
    ownerDmsTotal: lifetime.ownerDmsTotal,
    aiCostUsdByProvider: new Map(lifetime.aiCostUsdByProvider),
    rateLimitedTotal: lifetime.rateLimitedTotal,
    toolCalls: new Map(
      Array.from(lifetime.toolCalls, ([tool, counts]) => [tool, { ...counts }]),
    ),
    eventRemindersSentTotal: lifetime.eventRemindersSentTotal,
  };
}

/** Snapshot and reset — used by digest to get final stats for the day */
export function snapshotAndReset(): StatsSnapshot {
  const snapshot = current;
  current = freshStats();
  return snapshot;
}
