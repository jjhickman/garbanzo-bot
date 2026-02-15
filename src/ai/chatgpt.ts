/**
 * OpenAI chat caller with timeout and circuit breaker.
 */

import { logger } from '../middleware/logger.js';
import type { VisionImage } from '../core/vision.js';
import {
  buildProviderRequest,
  type CloudResponse,
} from './cloud-providers.js';

const REQUEST_TIMEOUT_MS = 30_000;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

let consecutiveOpenAIFailures = 0;
let circuitOpenUntil = 0;

/**
 * Call OpenAI chat completion as cloud fallback.
 */
export async function callChatGPT(
  systemPrompt: string,
  userMessage: string,
  visionImages?: VisionImage[],
): Promise<CloudResponse> {
  if (Date.now() < circuitOpenUntil) {
    const secondsRemaining = Math.ceil((circuitOpenUntil - Date.now()) / 1000);
    throw new Error(`OpenAI circuit breaker open (${secondsRemaining}s remaining)`);
  }

  const req = buildProviderRequest('openai', systemPrompt, userMessage, visionImages);
  if (!req) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    logger.debug({
      provider: req.provider,
      model: req.model,
      endpoint: req.endpoint,
      hasVision: !!visionImages?.length,
      imageCount: visionImages?.length ?? 0,
    }, 'Calling OpenAI provider');

    const response = await fetch(req.endpoint, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`openai API error ${response.status}: ${errorText}`);
    }

    const data: unknown = await response.json();
    const text = req.parser(data).trim();
    if (!text) throw new Error('openai returned empty response');

    consecutiveOpenAIFailures = 0;
    circuitOpenUntil = 0;
    return { text, provider: 'openai', model: req.model };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    consecutiveOpenAIFailures += 1;

    if (consecutiveOpenAIFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
      logger.warn({
        consecutiveOpenAIFailures,
        cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
      }, 'OpenAI circuit breaker opened after repeated failures');
    }

    logger.warn({
      provider: req.provider,
      model: req.model,
      endpoint: req.endpoint,
      timeoutMs: REQUEST_TIMEOUT_MS,
      err: error,
    }, 'OpenAI provider failed');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
