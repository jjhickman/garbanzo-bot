/**
 * OpenAI chat caller. Thin wrapper over the shared cloud-provider caller
 * (circuit breaker + timeout live in cloud-call.ts).
 */

import type { VisionImage } from '../core/vision.js';
import { buildProviderRequest, performHttpRequest, type CloudResponse } from './cloud-providers.js';
import { callCloudProvider } from './cloud-call.js';

/**
 * Call OpenAI chat completion as a cloud fallback.
 */
export async function callChatGPT(
  systemPrompt: string,
  userMessage: string,
  visionImages?: VisionImage[],
): Promise<CloudResponse> {
  const req = buildProviderRequest('openai', systemPrompt, userMessage, visionImages);
  if (!req) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  return callCloudProvider({
    provider: 'openai',
    model: req.model,
    perform: (signal) => performHttpRequest(req, signal),
  });
}
