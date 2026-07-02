/**
 * OpenAI chat caller. Thin wrapper over the shared cloud-provider caller
 * (circuit breaker + timeout live in cloud-call.ts).
 *
 * Two auth modes (config.OPENAI_AUTH_MODE):
 * - apikey (default): api.openai.com chat/completions with OPENAI_API_KEY.
 * - oauth (EXPERIMENTAL, ToS-grey; verified end-to-end against a live token
 *   2026-07-02): a ChatGPT-subscription token calls the private ChatGPT
 *   Responses backend over SSE. Any failure (missing/expired token, 4xx/5xx,
 *   or a stream error) throws so the router fails over to the next provider.
 */

import { config } from '../utils/config.js';
import type { VisionImage } from '../core/vision.js';
import {
  buildOpenAIResponsesRequest,
  buildProviderRequest,
  isOpenAiReasoningModel,
  performHttpRequest,
  performSseRequest,
  type CloudResponse,
} from './cloud-providers.js';
import { callCloudProvider } from './cloud-call.js';
import { getOpenAIAccessToken } from './openai-oauth.js';
import { runOpenAiCompatToolLoop, runOpenAiResponsesToolLoop } from './tool-loop.js';
import { getEnabledTools } from './tools.js';

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
        // The /wham backend is SSE-only (400 "Stream must be set to true" otherwise).
        return performSseRequest(req, signal);
      },
    });
  }

  const tools = config.AI_TOOL_CALLING && (!visionImages || visionImages.length === 0)
    ? getEnabledTools()
    : [];
  const req = buildProviderRequest(
    'openai',
    systemPrompt,
    userMessage,
    visionImages,
    tools.length > 0 ? tools : undefined,
  );
  if (!req) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  return callCloudProvider({
    provider: 'openai',
    model: req.model,
    perform: (signal) => {
      if (tools.length === 0) return performHttpRequest(req, signal);
      if (isOpenAiReasoningModel(req.model)) return runOpenAiResponsesToolLoop(req, tools, signal);
      return runOpenAiCompatToolLoop(req, tools, signal);
    },
  });
}
