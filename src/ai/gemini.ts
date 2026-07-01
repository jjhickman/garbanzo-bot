import { logger } from '../middleware/logger.js';
import { buildProviderRequest, type CloudResponse } from './cloud-providers.js';
import { callCloudProvider } from './cloud-call.js';
import type { VisionImage } from '../core/vision.js';

/**
 * Call the Gemini API (Google AI Studio) via the Generative Language REST
 * endpoint. Uses the shared cloud-provider caller (so Gemini now shares the same
 * circuit breaker + timeout as the other providers), but keeps its own transport
 * to preserve the explicit non-JSON error message.
 */
export async function callGemini(
  systemPrompt: string,
  userMessage: string,
  visionImages?: VisionImage[],
): Promise<CloudResponse> {
  const req = buildProviderRequest('gemini', systemPrompt, userMessage, visionImages);
  if (!req) throw new Error('gemini is not configured (missing GEMINI_API_KEY)');

  return callCloudProvider({
    provider: 'gemini',
    model: req.model,
    perform: async (signal) => {
      const response = await fetch(req.endpoint, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`gemini API error ${response.status}: ${text}`);
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (err) {
        logger.warn({ err, textPreview: text.slice(0, 200) }, 'gemini returned non-JSON response');
        throw new Error('gemini returned non-JSON response');
      }

      return req.parser(json);
    },
  });
}
