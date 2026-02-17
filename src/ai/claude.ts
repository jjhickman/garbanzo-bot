/**
 * Claude-family cloud caller with timeout and circuit breaker.
 *
 * Handles OpenRouter Claude and Anthropic direct Claude.
 */

import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import type { VisionImage } from '../core/vision.js';
import {
  buildProviderRequest,
  type CloudResponse,
} from './cloud-providers.js';

const REQUEST_TIMEOUT_MS = () => config.CLOUD_REQUEST_TIMEOUT_MS;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

let consecutiveClaudeFailures = 0;
let circuitOpenUntil = 0;

export type ClaudeProvider = 'openrouter' | 'anthropic';

/**
 * Call Claude providers with failover.
 *
 * Order: OpenRouter Claude -> Anthropic Claude.
 */
export async function callClaude(
  provider: ClaudeProvider,
  systemPrompt: string,
  userMessage: string,
  visionImages?: VisionImage[],
): Promise<CloudResponse> {
  if (Date.now() < circuitOpenUntil) {
    const secondsRemaining = Math.ceil((circuitOpenUntil - Date.now()) / 1000);
    throw new Error(`Claude circuit breaker open (${secondsRemaining}s remaining)`);
  }

  const req = buildProviderRequest(provider, systemPrompt, userMessage, visionImages);
  if (!req) {
    throw new Error(`${provider} provider not configured`);
  }

  const controller = new AbortController();
  const timeoutMs = REQUEST_TIMEOUT_MS();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    logger.debug({
      provider: req.provider,
      model: req.model,
      endpoint: req.endpoint,
      hasVision: !!visionImages?.length,
      imageCount: visionImages?.length ?? 0,
    }, 'Calling Claude provider');

    const response = await fetch(req.endpoint, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${req.provider} API error ${response.status}: ${errorText}`);
    }

    const data: unknown = await response.json();
    const text = req.parser(data).trim();
    if (!text) throw new Error(`${req.provider} returned empty response`);

    consecutiveClaudeFailures = 0;
    circuitOpenUntil = 0;
    return { text, provider: req.provider, model: req.model };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn({
      provider: req.provider,
      model: req.model,
      endpoint: req.endpoint,
      timeoutMs,
      err: error,
    }, 'Claude provider failed');

    consecutiveClaudeFailures += 1;
    if (consecutiveClaudeFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
      logger.warn({
        consecutiveClaudeFailures,
        cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
      }, 'Claude circuit breaker opened after repeated failures');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
