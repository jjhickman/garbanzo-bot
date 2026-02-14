/**
 * Claude API client — calls Claude via Anthropic Messages API or OpenRouter.
 *
 * Extracted from router.ts (Phase 7.3) for separation of concerns.
 * Router handles model selection; this module handles the actual API call.
 */

import { config } from '../utils/config.js';
import { logger } from '../middleware/logger.js';
import type { VisionImage } from '../features/media.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MessageContent = string | Array<Record<string, any>>;

/**
 * Call Claude via Anthropic Messages API.
 * Works with both direct Anthropic and OpenRouter (same API format).
 * Supports vision (image inputs) when visionImages are provided.
 */
export async function callClaude(
  systemPrompt: string,
  userMessage: string,
  visionImages?: VisionImage[],
): Promise<string> {
  // Prefer OpenRouter when available (better pricing + fallback routing)
  const isOpenRouter = !!config.OPENROUTER_API_KEY;
  const apiKey = isOpenRouter ? config.OPENROUTER_API_KEY : config.ANTHROPIC_API_KEY;
  const baseUrl = isOpenRouter
    ? 'https://openrouter.ai/api/v1'
    : 'https://api.anthropic.com';

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };

  if (isOpenRouter) {
    headers['authorization'] = `Bearer ${apiKey}`;
    headers['x-title'] = 'Garbanzo Bot';
  } else {
    headers['x-api-key'] = apiKey!;
  }

  const endpoint = isOpenRouter
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/messages`;

  // Build user content — text-only or multimodal with images
  const userContent = buildUserContent(userMessage, visionImages, isOpenRouter);

  const body = isOpenRouter
    ? {
        model: 'anthropic/claude-sonnet-4-5',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: 1024,
      }
    : {
        model: 'claude-sonnet-4-5-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      };

  logger.debug({
    endpoint,
    model: isOpenRouter ? 'openrouter' : 'anthropic',
    hasVision: !!visionImages?.length,
    imageCount: visionImages?.length ?? 0,
  }, 'Calling Claude');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI API error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as Record<string, unknown>;

  // Extract text from response (different formats)
  if (isOpenRouter) {
    const choices = data.choices as Array<{ message: { content: string } }> | undefined;
    return choices?.[0]?.message?.content ?? 'No response generated.';
  }
  const content = data.content as Array<{ text: string }> | undefined;
  return content?.[0]?.text ?? 'No response generated.';
}

/**
 * Build user message content for Claude API.
 * Plain string for text-only, array of content blocks for multimodal.
 */
export function buildUserContent(
  text: string,
  images: VisionImage[] | undefined,
  isOpenRouter: boolean,
): MessageContent {
  if (!images || images.length === 0) return text;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: Array<Record<string, any>> = [];

  for (const img of images) {
    if (isOpenRouter) {
      // OpenAI-compatible format: image_url with data URI
      blocks.push({
        type: 'image_url',
        image_url: {
          url: `data:${img.mediaType};base64,${img.base64}`,
        },
      });
    } else {
      // Anthropic native format: image with base64 source
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType,
          data: img.base64,
        },
      });
    }
  }

  // Add text prompt after images
  const textPrompt = text || 'What do you see in this image? Describe it and respond naturally.';
  blocks.push({ type: 'text', text: textPrompt });

  return blocks;
}
