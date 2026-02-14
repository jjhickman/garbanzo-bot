import { logger } from '../middleware/logger.js';
import { truncate } from '../utils/formatting.js';
import { buildSystemPrompt, buildOllamaPrompt, type MessageContext } from './persona.js';
import { callOllama, isOllamaAvailable } from './ollama.js';
import { recordAIRoute, recordAICost, recordAIError, estimateClaudeCost, getDailyCost, DAILY_COST_ALERT_THRESHOLD } from '../middleware/stats.js';
import { callClaude } from './claude.js';
import type { VisionImage } from '../features/media.js';

/**
 * Route a user query to the appropriate AI model and return the response.
 *
 * Routing strategy:
 * - Simple queries (greetings, short factual, casual chat) → Ollama (local, free)
 * - Complex queries (multi-step, persona-heavy, long) → Claude (API, paid)
 * - If Ollama fails or is unavailable → falls back to Claude
 *
 * Claude API client logic lives in claude.ts.
 */

/** Cached Ollama availability check — refreshed on failure */
let ollamaReachable: boolean | null = null;

/** Prevent spamming cost alerts — reset on rollover via stats module */
let costAlertSentToday = false;

// Reset cost alert flag at midnight (checked lazily on next call)
let lastAlertDate = new Date().toDateString();
function maybeResetCostAlert(): void {
  const today = new Date().toDateString();
  if (today !== lastAlertDate) {
    costAlertSentToday = false;
    lastAlertDate = today;
  }
}

async function checkOllama(): Promise<boolean> {
  if (ollamaReachable !== null) return ollamaReachable;
  ollamaReachable = await isOllamaAvailable();
  logger.info({ available: ollamaReachable }, 'Ollama availability check');
  return ollamaReachable;
}

export async function getAIResponse(
  query: string,
  ctx: MessageContext,
  visionImages?: VisionImage[],
): Promise<string | null> {
  if (!query.trim() && (!visionImages || visionImages.length === 0)) return null;

  maybeResetCostAlert();
  const complexity = classifyComplexity(query, ctx);
  // Always use Claude for vision (Ollama can't do multimodal well)
  const hasVision = visionImages && visionImages.length > 0;
  const useOllama = !hasVision && complexity === 'simple' && await checkOllama();

  try {
    if (useOllama) {
      const ollamaPrompt = buildOllamaPrompt(ctx);
      logger.info({ query: truncate(query, 80), model: 'ollama/qwen3:8b', complexity }, 'Routing to Ollama');
      recordAIRoute(ctx.groupJid, 'ollama');
      try {
        const t0 = Date.now();
        const response = await callOllama(ollamaPrompt, query);
        const latencyMs = Date.now() - t0;
        logger.info({ model: 'ollama/qwen3:8b', responseLen: response.length, latencyMs }, 'Ollama response received');
        recordAICost({ model: 'ollama', inputTokens: 0, outputTokens: 0, estimatedCost: 0, latencyMs });
        return truncate(response, 4000);
      } catch (err) {
        logger.warn({ err }, 'Ollama failed — falling back to Claude');
        recordAIError(ctx.groupJid);
        ollamaReachable = null; // Re-check availability next time
      }
    }

    // Claude path (primary for complex, fallback for Ollama failures)
    const systemPrompt = buildSystemPrompt(ctx, query);
    logger.info({ query: truncate(query, 80), model: 'claude', complexity, hasVision }, 'Routing to Claude');
    recordAIRoute(ctx.groupJid, 'claude');
    const t0 = Date.now();
    const response = await callClaude(systemPrompt, query, visionImages);
    const latencyMs = Date.now() - t0;
    const costEntry = estimateClaudeCost(systemPrompt, query, response);
    costEntry.latencyMs = latencyMs;
    recordAICost(costEntry);
    logger.info({
      model: 'claude',
      responseLen: response.length,
      latencyMs,
      estCost: `$${costEntry.estimatedCost.toFixed(4)}`,
      dailyTotal: `$${getDailyCost().toFixed(4)}`,
    }, 'Claude response received');

    // Alert owner if daily cost is approaching threshold
    if (getDailyCost() >= DAILY_COST_ALERT_THRESHOLD && !costAlertSentToday) {
      costAlertSentToday = true;
      logger.warn({ dailyCost: getDailyCost(), threshold: DAILY_COST_ALERT_THRESHOLD }, 'Daily cost alert threshold reached');
      // The alert is logged; digest will surface it. Direct DM alerting
      // is wired through the daily digest, not here (avoid circular deps).
    }

    return truncate(response, 4000);
  } catch (err) {
    logger.error({ err, query }, 'AI response failed');
    recordAIError(ctx.groupJid);
    return '🫘 Sorry, I hit a snag processing that. Try again in a moment.';
  }
}

// ── Query complexity classifier ─────────────────────────────────────

export type Complexity = 'simple' | 'complex';

/**
 * Classify a query as simple or complex to decide routing.
 *
 * Simple (→ Ollama):
 * - Greetings, short casual chat
 * - Short factual questions ("what time is it?", "best pizza in Boston?")
 * - Single-topic opinions
 * - Messages under ~100 chars with no special context
 *
 * Complex (→ Claude):
 * - Introduction welcomes (need rich persona)
 * - Event enrichment prompts (multi-part)
 * - Multi-step questions, comparisons, explanations
 * - Messages with quoted context (replies)
 * - Long messages (100+ chars)
 * - Anything in the Introductions or Events group (persona matters more)
 */
export function classifyComplexity(query: string, ctx: MessageContext): Complexity {
  // Always use Claude for groups where persona quality matters most
  if (ctx.groupName === 'Introductions' || ctx.groupName === 'Events') {
    return 'complex';
  }

  // Always use Claude when replying to quoted messages (needs context understanding)
  if (ctx.quotedText) {
    return 'complex';
  }

  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();

  // Context-dependent queries need Claude (8B models hallucinate when reading context)
  if (/\b(i (just )?said|you said|we said|just (said|mentioned|asked|talked)|earlier|before|above|previous|recap|summarize|what did)\b/i.test(lower)) {
    return 'complex';
  }

  // Very short messages are likely greetings/casual → simple
  if (trimmed.length < 20) return 'simple';

  // Long messages need better reasoning → complex
  if (trimmed.length > 150) return 'complex';

  // Greeting patterns → simple
  if (/^(hey|hi|hello|yo|sup|what'?s? up|howdy|morning|gm|good (morning|afternoon|evening))\b/i.test(lower)) {
    return 'simple';
  }

  // Simple question patterns → simple
  if (/^(what|where|who|when|how)\s+(is|are|was|do|does|did|time|much|many|long|far|old)\b/i.test(lower)) {
    // But multi-clause questions are complex
    if (trimmed.includes('?') && trimmed.indexOf('?') < trimmed.length - 5) return 'complex';
    if (trimmed.length > 100) return 'complex';
    return 'simple';
  }

  // "Tell me" / "what do you think" → simple if short
  if (/^(tell me|recommend|suggest|what do you think|opinion on)\b/i.test(lower) && trimmed.length < 80) {
    return 'simple';
  }

  // "Thank" / acknowledgment that slipped through → simple
  if (/^(thanks?|ty|thx|cool|nice|ok|got it|makes sense)\b/i.test(lower)) {
    return 'simple';
  }

  // Multiple sentences or complex connectors → complex
  if ((trimmed.match(/[.!?]/g)?.length ?? 0) > 2) return 'complex';
  if (/\b(because|however|although|compare|difference|explain|versus|vs)\b/i.test(lower)) return 'complex';

  // Medium length, no strong signals → default to simple (save costs)
  if (trimmed.length <= 100) return 'simple';

  return 'complex';
}
