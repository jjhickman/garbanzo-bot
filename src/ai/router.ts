import { logger } from '../middleware/logger.js';
import { truncate } from '../utils/formatting.js';
import { config } from '../utils/config.js';
import { buildSystemPrompt, buildOllamaPrompt, type MessageContext } from './persona.js';
import { callOllama, isOllamaAvailable } from './ollama.js';
import {
  recordAIRoute,
  recordAICost,
  recordAIError,
  estimateClaudeCost,
  estimateOpenAICost,
  estimateGeminiCost,
  getDailyCost,
  DAILY_COST_ALERT_THRESHOLD,
} from '../middleware/stats.js';
import { callClaude } from './claude.js';
import { callChatGPT } from './chatgpt.js';
import { callGemini } from './gemini.js';
import type { CloudProvider, CloudResponse } from './cloud-providers.js';
import type { VisionImage } from '../features/media.js';

/**
 * Route a user query to the appropriate AI model and return the response.
 *
 * Routing strategy:
 * - Simple queries (greetings, short factual, casual chat) → Ollama (local, free)
 * - Complex queries (multi-step, persona-heavy, long) → cloud model (API, paid)
 * - If Ollama fails or is unavailable → falls back to cloud model
 *
 * Claude and OpenAI provider logic lives in ai/claude.ts and ai/chatgpt.ts.
 */

/** Cached Ollama availability check — refreshed on failure */
let ollamaReachable: boolean | null = null;

const DEFAULT_PROVIDER_ORDER: CloudProvider[] = ['openrouter', 'anthropic', 'openai', 'gemini'];

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

function getConfiguredProviderOrder(): CloudProvider[] {
  const requested = config.AI_PROVIDER_ORDER
    .split(',')
    .map((provider: string) => provider.trim().toLowerCase())
    .filter(Boolean)
    .filter((provider): provider is CloudProvider =>
      DEFAULT_PROVIDER_ORDER.includes(provider as CloudProvider),
    );

  return Array.from(new Set(requested));
}

function isProviderConfigured(provider: CloudProvider): boolean {
  if (provider === 'openrouter') return !!config.OPENROUTER_API_KEY;
  if (provider === 'anthropic') return !!config.ANTHROPIC_API_KEY;
  if (provider === 'gemini') return !!config.GEMINI_API_KEY;
  return !!config.OPENAI_API_KEY;
}

/**
 * Route a message to Ollama or cloud providers and return final reply text.
 */
export async function getAIResponse(
  query: string,
  ctx: MessageContext,
  visionImages?: VisionImage[],
): Promise<string | null> {
  if (!query.trim() && (!visionImages || visionImages.length === 0)) return null;

  maybeResetCostAlert();
  const complexity = classifyComplexity(query, ctx);
  // Always use cloud providers for vision (Ollama can't do multimodal well)
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
        logger.warn({ err, groupJid: ctx.groupJid }, 'Ollama failed — falling back to cloud providers');
        recordAIError(ctx.groupJid);
        ollamaReachable = null; // Re-check availability next time
      }
    }

    // Cloud model path (primary for complex, fallback for Ollama failures)
    const systemPrompt = buildSystemPrompt(ctx, query);
    const providerOrder = getConfiguredProviderOrder();
    logger.info({
      query: truncate(query, 80),
      model: 'cloud',
      complexity,
      hasVision,
      providerOrder,
    }, 'Routing to cloud providers');

    const t0 = Date.now();
    let aiResult: CloudResponse;

    let lastProviderError: Error | null = null;
    let resolved = false;
    aiResult = { text: '', provider: 'openai', model: '' };

    const configuredProviders = providerOrder.filter(isProviderConfigured);
    if (configuredProviders.length === 0) {
      throw new Error(
        `No configured providers available in AI_PROVIDER_ORDER=${config.AI_PROVIDER_ORDER}`,
      );
    }

    for (const provider of configuredProviders) {
      try {
        if (provider === 'openai') {
          aiResult = await callChatGPT(systemPrompt, query, visionImages);
        } else if (provider === 'gemini') {
          aiResult = await callGemini(systemPrompt, query, visionImages);
        } else {
          aiResult = await callClaude(provider, systemPrompt, query, visionImages);
        }
        resolved = true;
        break;
      } catch (providerErr) {
        const error = providerErr instanceof Error ? providerErr : new Error(String(providerErr));
        lastProviderError = error;
        logger.warn({ err: error, provider, groupJid: ctx.groupJid }, 'Cloud provider failed — trying next in configured order');
      }
    }

    if (!resolved) {
      throw new Error(`All configured cloud providers failed. Last error: ${lastProviderError?.message ?? 'unknown error'}`);
    }

    const latencyMs = Date.now() - t0;
    const routedModel = aiResult.provider === 'openai'
      ? 'openai'
      : aiResult.provider === 'gemini'
        ? 'gemini'
        : 'claude';
    recordAIRoute(ctx.groupJid, routedModel);

    const costEntry = routedModel === 'openai'
      ? estimateOpenAICost(systemPrompt, query, aiResult.text)
      : routedModel === 'gemini'
        ? estimateGeminiCost(systemPrompt, query, aiResult.text)
        : estimateClaudeCost(systemPrompt, query, aiResult.text);
    costEntry.latencyMs = latencyMs;
    recordAICost(costEntry);
    logger.info({
      provider: aiResult.provider,
      model: aiResult.model,
      responseLen: aiResult.text.length,
      latencyMs,
      estCost: `$${costEntry.estimatedCost.toFixed(4)}`,
      dailyTotal: `$${getDailyCost().toFixed(4)}`,
    }, 'Cloud response received');

    // Alert owner if daily cost is approaching threshold
    if (getDailyCost() >= DAILY_COST_ALERT_THRESHOLD && !costAlertSentToday) {
      costAlertSentToday = true;
      logger.warn({ dailyCost: getDailyCost(), threshold: DAILY_COST_ALERT_THRESHOLD }, 'Daily cost alert threshold reached');
      // The alert is logged; digest will surface it. Direct DM alerting
      // is wired through the daily digest, not here (avoid circular deps).
    }

    return truncate(aiResult.text, 4000);
  } catch (err) {
    logger.error({ err, query }, 'AI response failed');
    recordAIError(ctx.groupJid);
    return '🫘 Sorry, I hit a snag processing that. Try again in a moment.';
  }
}

// ── Query complexity classifier ─────────────────────────────────────

type Complexity = 'simple' | 'complex';

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
