/**
 * Claude-family cloud caller (OpenRouter Claude + Anthropic direct). Thin
 * wrapper over the shared cloud-provider caller; each provider gets its own
 * circuit breaker (keyed by provider) in cloud-call.ts.
 */

import type { VisionImage } from '../core/vision.js';
import { config } from '../utils/config.js';
import { buildProviderRequest, performHttpRequest, type CloudResponse } from './cloud-providers.js';
import { callCloudProvider } from './cloud-call.js';
import { runAnthropicToolLoop, runOpenAiCompatToolLoop } from './tool-loop.js';
import { getEnabledTools } from './tools.js';

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
  const tools = config.AI_TOOL_CALLING && (!visionImages || visionImages.length === 0)
    ? getEnabledTools()
    : [];
  const req = buildProviderRequest(
    provider,
    systemPrompt,
    userMessage,
    visionImages,
    tools.length > 0 ? tools : undefined,
  );
  if (!req) {
    throw new Error(`${provider} provider not configured`);
  }

  return callCloudProvider({
    provider: req.provider,
    model: req.model,
    perform: (signal) => {
      if (tools.length === 0) return performHttpRequest(req, signal);
      if (provider === 'anthropic') return runAnthropicToolLoop(req, tools, signal);
      return runOpenAiCompatToolLoop(req, tools, signal);
    },
  });
}
