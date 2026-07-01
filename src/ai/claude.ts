/**
 * Claude-family cloud caller (OpenRouter Claude + Anthropic direct). Thin
 * wrapper over the shared cloud-provider caller; each provider gets its own
 * circuit breaker (keyed by provider) in cloud-call.ts.
 */

import type { VisionImage } from '../core/vision.js';
import { buildProviderRequest, performHttpRequest, type CloudResponse } from './cloud-providers.js';
import { callCloudProvider } from './cloud-call.js';

export type ClaudeProvider = 'openrouter' | 'anthropic';

/**
 * Call a Claude provider (OpenRouter or Anthropic direct).
 */
export async function callClaude(
  provider: ClaudeProvider,
  systemPrompt: string,
  userMessage: string,
  visionImages?: VisionImage[],
): Promise<CloudResponse> {
  const req = buildProviderRequest(provider, systemPrompt, userMessage, visionImages);
  if (!req) {
    throw new Error(`${provider} provider not configured`);
  }

  return callCloudProvider({
    provider: req.provider,
    model: req.model,
    perform: (signal) => performHttpRequest(req, signal),
  });
}
