import { logger } from '../middleware/logger.js';
import { buildProviderRequest, type CloudResponse } from './cloud-providers.js';
import type { VisionImage } from '../core/vision.js';

/** Call the Gemini API (Google AI Studio) via the Generative Language REST endpoint. */
export async function callGemini(
  systemPrompt: string,
  userMessage: string,
  visionImages?: VisionImage[],
): Promise<CloudResponse> {
  const req = buildProviderRequest('gemini', systemPrompt, userMessage, visionImages);
  if (!req) throw new Error('gemini is not configured (missing GEMINI_API_KEY)');

  const t0 = Date.now();
  const response = await fetch(req.endpoint, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
  });
  const latencyMs = Date.now() - t0;

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

  const out = req.parser(json);
  if (!out) throw new Error('gemini returned empty response');

  logger.info({ provider: 'gemini', model: req.model, latencyMs }, 'Gemini response received');
  return { text: out, provider: 'gemini', model: req.model };
}
