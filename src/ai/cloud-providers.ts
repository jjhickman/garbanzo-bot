import { z } from 'zod';
import { config } from '../utils/config.js';
import type { VisionImage } from '../core/vision.js';

/** Cloud providers supported for fallback chain. */
export type CloudProvider = 'openrouter' | 'anthropic' | 'openai' | 'gemini' | 'bedrock';

/** Normalized cloud AI response metadata. */
export interface CloudResponse {
  text: string;
  provider: CloudProvider;
  model: string;
}

/** Provider-specific request configuration. */
export interface ProviderRequest {
  provider: CloudProvider;
  model: string;
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  parser: (data: unknown) => string;
}

interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

interface OpenAIImageBlock {
  type: 'image_url';
  image_url: { url: string };
}

interface TextBlock {
  type: 'text';
  text: string;
}

type AnthropicContentBlock = AnthropicImageBlock | TextBlock;
type OpenAIContentBlock = OpenAIImageBlock | TextBlock;
type AnthropicMessageContent = string | AnthropicContentBlock[];
type OpenAIMessageContent = string | OpenAIContentBlock[];

const ChatCompletionResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.union([
        z.string(),
        z.array(z.object({
          type: z.string().optional(),
          text: z.string().optional(),
        })),
      ]),
    }),
  })),
});

const AnthropicResponseSchema = z.object({
  content: z.array(z.object({
    type: z.string().optional(),
    text: z.string().optional(),
  })),
});

const GeminiResponseSchema = z.object({
  candidates: z.array(z.object({
    content: z.object({
      parts: z.array(z.object({
        text: z.string().optional(),
      })),
    }),
  })).optional(),
});

/** Build a provider-specific request if that provider is configured. */
export function buildProviderRequest(
  provider: CloudProvider,
  systemPrompt: string,
  userMessage: string,
  visionImages?: VisionImage[],
): ProviderRequest | null {
  if (provider === 'openrouter') {
    if (!config.OPENROUTER_API_KEY) return null;
    return {
      provider: 'openrouter',
      model: config.OPENROUTER_MODEL,
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
        'x-title': 'Garbanzo',
      },
      body: {
        model: config.OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: buildOpenAICompatibleUserContent(userMessage, visionImages) },
        ],
        max_tokens: config.CLOUD_MAX_TOKENS,
      },
      parser: parseChatCompletionResponse,
    };
  }

  if (provider === 'anthropic') {
    if (!config.ANTHROPIC_API_KEY) return null;
    return {
      provider: 'anthropic',
      model: config.ANTHROPIC_MODEL,
      endpoint: 'https://api.anthropic.com/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: config.ANTHROPIC_MODEL,
        max_tokens: config.CLOUD_MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: buildAnthropicUserContent(userMessage, visionImages) }],
      },
      parser: parseAnthropicResponse,
    };
  }

  if (provider === 'gemini') {
    if (!config.GEMINI_API_KEY) return null;
    return {
      provider: 'gemini',
      model: config.GEMINI_MODEL,
      endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${config.GEMINI_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`,
      headers: {
        'content-type': 'application/json',
      },
      body: {
        systemInstruction: {
          role: 'system',
          parts: [{ text: systemPrompt }],
        },
        contents: [{
          role: 'user',
          parts: buildGeminiUserParts(userMessage, visionImages),
        }],
        generationConfig: {
          maxOutputTokens: config.CLOUD_MAX_TOKENS,
        },
      },
      parser: parseGeminiResponse,
    };
  }

  if (!config.OPENAI_API_KEY) return null;
  return {
    provider: 'openai',
    model: config.OPENAI_MODEL,
    endpoint: 'https://api.openai.com/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.OPENAI_API_KEY}`,
    },
    body: {
      model: config.OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildOpenAICompatibleUserContent(userMessage, visionImages) },
      ],
      max_tokens: config.CLOUD_MAX_TOKENS,
    },
    parser: parseChatCompletionResponse,
  };
}

/** EXPERIMENTAL: ChatGPT-subscription backend used by OpenAI OAuth mode. */
const OPENAI_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/wham/responses';

const ResponsesApiSchema = z.object({
  output_text: z.union([z.string(), z.array(z.string())]).optional(),
  output: z.array(z.object({
    type: z.string().optional(),
    content: z.array(z.object({
      type: z.string().optional(),
      text: z.string().optional(),
    })).optional(),
  })).optional(),
});

/**
 * Build the OpenAI Responses-API request for OAuth ("Sign in with ChatGPT")
 * mode (EXPERIMENTAL, unverified against a live token). Targets the private
 * ChatGPT backend with a fresh bearer token + account header. Distinct from the
 * apikey chat/completions request: content type is `input_text` and `store` is
 * false, with the system prompt passed as `instructions`.
 */
export function buildOpenAIResponsesRequest(
  systemPrompt: string,
  userMessage: string,
  visionImages: VisionImage[] | undefined,
  accessToken: string,
  accountId: string | null,
): ProviderRequest {
  const content: Array<Record<string, unknown>> = [];
  if (visionImages && visionImages.length > 0) {
    for (const img of visionImages) {
      content.push({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.base64}` });
    }
  }
  content.push({
    type: 'input_text',
    text: userMessage || 'What do you see in this image? Describe it and respond naturally.',
  });

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${accessToken}`,
    originator: 'garbanzo',
  };
  if (accountId) headers['chatgpt-account-id'] = accountId;

  return {
    provider: 'openai',
    model: config.OPENAI_MODEL,
    endpoint: OPENAI_RESPONSES_ENDPOINT,
    headers,
    body: {
      model: config.OPENAI_MODEL,
      instructions: systemPrompt,
      input: [{ role: 'user', content }],
      store: false,
    },
    parser: parseResponsesApiResponse,
  };
}

function parseResponsesApiResponse(data: unknown): string {
  const parsed = ResponsesApiSchema.safeParse(data);
  if (!parsed.success) return 'No response generated.';

  if (typeof parsed.data.output_text === 'string') {
    return parsed.data.output_text.trim() || 'No response generated.';
  }
  if (Array.isArray(parsed.data.output_text)) {
    return parsed.data.output_text.join('').trim() || 'No response generated.';
  }

  const texts: string[] = [];
  for (const item of parsed.data.output ?? []) {
    for (const block of item.content ?? []) {
      if (block.text) texts.push(block.text);
    }
  }
  return texts.join('').trim() || 'No response generated.';
}

/**
 * Standard HTTP transport for fetch-based providers (openrouter/anthropic/openai
 * API-key mode). Posts the built request under the caller's abort signal, maps a
 * non-2xx to `"<provider> API error <status>: <body>"`, and runs the parser.
 * (Gemini keeps its own perform to preserve its non-JSON error message.)
 */
export async function performHttpRequest(req: ProviderRequest, signal: AbortSignal): Promise<string> {
  const response = await fetch(req.endpoint, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${req.provider} API error ${response.status}: ${errorText}`);
  }

  const data: unknown = await response.json();
  return req.parser(data);
}

function parseChatCompletionResponse(data: unknown): string {
  const parsed = ChatCompletionResponseSchema.safeParse(data);
  if (!parsed.success) return 'No response generated.';

  const content = parsed.data.choices[0]?.message.content;
  if (typeof content === 'string') return content;
  return content.map((block) => block.text ?? '').join('').trim() || 'No response generated.';
}

function parseAnthropicResponse(data: unknown): string {
  const parsed = AnthropicResponseSchema.safeParse(data);
  if (!parsed.success) return 'No response generated.';
  return parsed.data.content.map((block) => block.text ?? '').join('').trim() || 'No response generated.';
}

function parseGeminiResponse(data: unknown): string {
  const parsed = GeminiResponseSchema.safeParse(data);
  if (!parsed.success) return 'No response generated.';

  const parts = parsed.data.candidates?.[0]?.content.parts;
  if (!parts || parts.length === 0) return 'No response generated.';
  return parts.map((p) => p.text ?? '').join('').trim() || 'No response generated.';
}

function buildAnthropicUserContent(
  text: string,
  images: VisionImage[] | undefined,
): AnthropicMessageContent {
  if (!images || images.length === 0) return text;

  const blocks: AnthropicContentBlock[] = [];
  for (const img of images) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: img.base64,
      },
    });
  }

  const textPrompt = text || 'What do you see in this image? Describe it and respond naturally.';
  blocks.push({ type: 'text', text: textPrompt });
  return blocks;
}

function buildOpenAICompatibleUserContent(
  text: string,
  images: VisionImage[] | undefined,
): OpenAIMessageContent {
  if (!images || images.length === 0) return text;

  const blocks: OpenAIContentBlock[] = [];
  for (const img of images) {
    blocks.push({
      type: 'image_url',
      image_url: {
        url: `data:${img.mediaType};base64,${img.base64}`,
      },
    });
  }

  const textPrompt = text || 'What do you see in this image? Describe it and respond naturally.';
  blocks.push({ type: 'text', text: textPrompt });
  return blocks;
}

function buildGeminiUserParts(
  text: string,
  images: VisionImage[] | undefined,
): Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> {
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

  if (images && images.length > 0) {
    for (const img of images) {
      parts.push({
        inlineData: {
          mimeType: img.mediaType,
          data: img.base64,
        },
      });
    }
  }

  const textPrompt = text || 'What do you see in this image? Describe it and respond naturally.';
  parts.push({ text: textPrompt });
  return parts;
}
