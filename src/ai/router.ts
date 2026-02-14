import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { truncate } from '../utils/formatting.js';
import { buildSystemPrompt, type MessageContext } from './persona.js';

/**
 * Route a user query to the appropriate AI model and return the response.
 *
 * Phase 1: Claude only (via Anthropic API or OpenRouter).
 * Phase 2: Add Ollama fallback for simple queries.
 */
export async function getAIResponse(
  query: string,
  ctx: MessageContext,
): Promise<string | null> {
  if (!query.trim()) return null;

  const systemPrompt = buildSystemPrompt(ctx);

  try {
    const response = await callClaude(systemPrompt, query);
    return truncate(response, 4000);
  } catch (err) {
    logger.error({ err, query }, 'AI response failed');
    return '🫘 Sorry, I hit a snag processing that. Try again in a moment.';
  }
}

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

  logger.debug({ endpoint, model: isOpenRouter ? 'openrouter' : 'anthropic' }, 'Calling AI');

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
