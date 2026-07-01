/**
 * OpenAI chat caller. Thin wrapper over the shared cloud-provider caller
 * (circuit breaker + timeout live in cloud-call.ts).
 *
 * Two auth modes (config.OPENAI_AUTH_MODE):
 * - apikey (default): api.openai.com chat/completions with OPENAI_API_KEY.
 * - oauth (EXPERIMENTAL, ToS-grey): a ChatGPT-subscription token calls the
 *   private ChatGPT Responses backend. Any failure (missing/expired token or a
 *   4xx/5xx) throws so the router fails over to the next provider.
 */

import { config } from '../utils/config.js';
import type { VisionImage } from '../core/vision.js';
import {
  buildOpenAIResponsesRequest,
  buildProviderRequest,
  performHttpRequest,
  type CloudResponse,
} from './cloud-providers.js';
import { callCloudProvider } from './cloud-call.js';
import { getOpenAIAccessToken } from './openai-oauth.js';

/**
 * Call OpenAI as a cloud fallback.
 */
export async function callChatGPT(
  systemPrompt: string,
  userMessage: string,
  visionImages?: VisionImage[],
): Promise<CloudResponse> {
  if (config.OPENAI_AUTH_MODE === 'oauth') {
    return callCloudProvider({
      provider: 'openai',
      model: config.OPENAI_MODEL,
      perform: async (signal) => {
        const { accessToken, accountId } = await getOpenAIAccessToken();
        const req = buildOpenAIResponsesRequest(systemPrompt, userMessage, visionImages, accessToken, accountId);
        return performHttpRequest(req, signal);
      },
    });
  }

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
