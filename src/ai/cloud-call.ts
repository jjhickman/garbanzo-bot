/**
 * Shared cloud-provider caller: circuit breaker + timeout around a per-provider
 * transport. Extracted from the previously duplicated logic in chatgpt.ts,
 * claude.ts, and bedrock.ts so every provider (including gemini) shares one
 * breaker/timeout implementation.
 */

import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import type { CloudProvider, CloudResponse } from './cloud-providers.js';

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

interface BreakerState {
  failures: number;
  openUntil: number;
}

const breakers = new Map<CloudProvider, BreakerState>();

function getBreaker(provider: CloudProvider): BreakerState {
  let breaker = breakers.get(provider);
  if (!breaker) {
    breaker = { failures: 0, openUntil: 0 };
    breakers.set(provider, breaker);
  }
  return breaker;
}

export interface CloudCallOptions {
  provider: CloudProvider;
  model: string;
  /** Defaults to config.CLOUD_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Perform the transport (fetch/SDK). Returns raw text; throws on transport/HTTP error. */
  perform: (signal: AbortSignal) => Promise<string>;
}

/**
 * Call a cloud provider with a per-provider circuit breaker and a request
 * timeout. Preserves the prior semantics exactly: 3 consecutive failures trip a
 * 60s cooldown, success resets the count, an open breaker throws before the
 * transport runs, and an empty response counts as a failure.
 */
export async function callCloudProvider(opts: CloudCallOptions): Promise<CloudResponse> {
  const breaker = getBreaker(opts.provider);

  if (Date.now() < breaker.openUntil) {
    const secondsRemaining = Math.ceil((breaker.openUntil - Date.now()) / 1000);
    throw new Error(`${opts.provider} circuit breaker open (${secondsRemaining}s remaining)`);
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? config.CLOUD_REQUEST_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const text = (await opts.perform(controller.signal)).trim();
    if (!text) throw new Error(`${opts.provider} returned empty response`);

    breaker.failures = 0;
    breaker.openUntil = 0;
    return { text, provider: opts.provider, model: opts.model };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    breaker.failures += 1;

    if (breaker.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      breaker.openUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
      logger.warn(
        { provider: opts.provider, failures: breaker.failures, cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS },
        'Cloud provider circuit breaker opened after repeated failures',
      );
    }

    logger.warn({ provider: opts.provider, model: opts.model, timeoutMs, err: error }, 'Cloud provider failed');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Test-only: clear all breaker state. */
export function __resetCloudBreakers(): void {
  breakers.clear();
}
