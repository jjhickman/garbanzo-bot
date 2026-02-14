import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { truncate } from '../utils/formatting.js';
import { buildSystemPrompt, buildOllamaPrompt, type MessageContext } from './persona.js';
import { callOllama, isOllamaAvailable } from './ollama.js';

/**
 * Route a user query to the appropriate AI model and return the response.
 *
 * Routing strategy:
 * - Simple queries (greetings, short factual, casual chat) → Ollama (local, free)
 * - Complex queries (multi-step, persona-heavy, long) → Claude (API, paid)
 * - If Ollama fails or is unavailable → falls back to Claude
 */

/** Cached Ollama availability check — refreshed on failure */
let ollamaReachable: boolean | null = null;

async function checkOllama(): Promise<boolean> {
  if (ollamaReachable !== null) return ollamaReachable;
  ollamaReachable = await isOllamaAvailable();
  logger.info({ available: ollamaReachable }, 'Ollama availability check');
  return ollamaReachable;
}

export async function getAIResponse(
  query: string,
  ctx: MessageContext,
): Promise<string | null> {
  if (!query.trim()) return null;

  const complexity = classifyComplexity(query, ctx);
  const useOllama = complexity === 'simple' && await checkOllama();

  try {
    if (useOllama) {
      const ollamaPrompt = buildOllamaPrompt(ctx);
      logger.info({ query: truncate(query, 80), model: 'ollama/qwen3:8b', complexity }, 'Routing to Ollama');
      try {
        const response = await callOllama(ollamaPrompt, query);
        logger.info({ model: 'ollama/qwen3:8b', responseLen: response.length }, 'Ollama response received');
        return truncate(response, 4000);
      } catch (err) {
        logger.warn({ err }, 'Ollama failed — falling back to Claude');
        ollamaReachable = null; // Re-check availability next time
      }
    }

    // Claude path (primary for complex, fallback for Ollama failures)
    const systemPrompt = buildSystemPrompt(ctx);
    logger.info({ query: truncate(query, 80), model: 'claude', complexity }, 'Routing to Claude');
    const response = await callClaude(systemPrompt, query);
    logger.info({ model: 'claude', responseLen: response.length }, 'Claude response received');
    return truncate(response, 4000);
  } catch (err) {
    logger.error({ err, query }, 'AI response failed');
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
function classifyComplexity(query: string, ctx: MessageContext): Complexity {
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

// ── Claude client ───────────────────────────────────────────────────

/**
 * Call Claude via Anthropic Messages API.
 * Works with both direct Anthropic and OpenRouter (same API format).
 */
async function callClaude(
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  // Prefer OpenRouter when available (better pricing + fallback routing)
  const isOpenRouter = !!config.OPENROUTER_API_KEY;
  const apiKey = isOpenRouter ? config.OPENROUTER_API_KEY : config.ANTHROPIC_API_KEY;
  const baseUrl = isOpenRouter
    ? 'https://openrouter.ai/api/v1'
    : 'https://api.anthropic.com';

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };

  if (isOpenRouter) {
    headers['authorization'] = `Bearer ${apiKey}`;
    headers['x-title'] = 'Garbanzo Bot';
  } else {
    headers['x-api-key'] = apiKey!;
  }

  const endpoint = isOpenRouter
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/messages`;

  const body = isOpenRouter
    ? {
        model: 'anthropic/claude-sonnet-4-5',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 1024,
      }
    : {
        model: 'claude-sonnet-4-5-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      };

  logger.debug({ endpoint, model: isOpenRouter ? 'openrouter' : 'anthropic' }, 'Calling Claude');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI API error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as Record<string, unknown>;

  // Extract text from response (different formats)
  if (isOpenRouter) {
    const choices = data.choices as Array<{ message: { content: string } }> | undefined;
    return choices?.[0]?.message?.content ?? 'No response generated.';
  }
  const content = data.content as Array<{ text: string }> | undefined;
  return content?.[0]?.text ?? 'No response generated.';
}
