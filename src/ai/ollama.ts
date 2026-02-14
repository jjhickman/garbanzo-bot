import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';

/**
 * Ollama client — local AI inference via the OpenAI-compatible API.
 *
 * Uses qwen3:8b for simple queries (greetings, short factual,
 * casual chat) to reduce Claude API costs.
 */

const DEFAULT_MODEL = 'qwen3:8b';
const MAX_TOKENS = 512;
const TIMEOUT_MS = 15_000;

/**
 * Call the local Ollama instance via its OpenAI-compatible endpoint.
 * Returns the generated text, or throws on failure.
 */
export async function callOllama(
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const endpoint = `${config.OLLAMA_BASE_URL}/v1/chat/completions`;

  const body = {
    model: DEFAULT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    max_tokens: MAX_TOKENS,
    temperature: 0.7,
  };

  logger.debug({ endpoint, model: DEFAULT_MODEL }, 'Calling Ollama');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as Record<string, unknown>;
    const choices = data.choices as Array<{ message: { content: string } }> | undefined;
    const content = choices?.[0]?.message?.content;

    if (!content) throw new Error('Ollama returned empty response');

    return content;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check if Ollama is reachable and the model is loaded.
 * Used at startup to determine if local routing is available.
 */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${config.OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;

    const data = await response.json() as { models: Array<{ name: string }> };
    return data.models.some((m) => m.name.startsWith(DEFAULT_MODEL.split(':')[0]));
  } catch {
    return false;
  }
}

// ── Warm-up ping ────────────────────────────────────────────────────

/** Interval between keep-alive pings (10 minutes) */
const WARMUP_INTERVAL_MS = 10 * 60 * 1000;
let warmupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Send a keep-alive request to Ollama to prevent model unloading.
 * Uses the /api/generate endpoint with keep_alive to reset the idle timer
 * without generating any tokens.
 */
async function pingOllama(): Promise<void> {
  try {
    const response = await fetch(`${config.OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        prompt: '',
        keep_alive: '15m',
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      // Consume response body to prevent connection leak
      await response.text();
      logger.debug({ model: DEFAULT_MODEL }, 'Ollama warm-up ping OK');
    } else {
      logger.warn({ status: response.status }, 'Ollama warm-up ping failed');
    }
  } catch (err) {
    logger.debug({ err }, 'Ollama warm-up ping error (server may be down)');
  }
}

/**
 * Start periodic warm-up pings. Call once at startup.
 * Sends an immediate ping, then repeats every 10 minutes.
 */
export function startOllamaWarmup(): void {
  // Immediate ping to pre-load the model
  pingOllama().catch(() => {});

  warmupTimer = setInterval(() => {
    pingOllama().catch(() => {});
  }, WARMUP_INTERVAL_MS);

  logger.info({ intervalMin: WARMUP_INTERVAL_MS / 60_000, model: DEFAULT_MODEL }, 'Ollama warm-up scheduled');
}

/** Stop the warm-up timer (for graceful shutdown) */
export function stopOllamaWarmup(): void {
  if (warmupTimer) {
    clearInterval(warmupTimer);
    warmupTimer = null;
  }
}
