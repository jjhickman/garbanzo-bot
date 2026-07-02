import { z } from 'zod';
import { config } from '../utils/config.js';
import type { VisionImage } from '../core/vision.js';
import type { AiTool } from './tools.js';

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

interface OpenAIResponsesImageBlock {
  type: 'input_image';
  image_url: string;
}

interface TextBlock {
  type: 'text';
  text: string;
}

interface OpenAIResponsesTextBlock {
  type: 'input_text';
  text: string;
}

type AnthropicContentBlock = AnthropicImageBlock | TextBlock;
type OpenAIContentBlock = OpenAIImageBlock | TextBlock;
type OpenAIResponsesContentBlock = OpenAIResponsesImageBlock | OpenAIResponsesTextBlock;
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
  tools?: AiTool[],
): ProviderRequest | null {
  if (provider === 'openrouter') {
    if (!config.OPENROUTER_API_KEY) return null;
    const body: Record<string, unknown> = {
      model: config.OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildOpenAICompatibleUserContent(userMessage, visionImages) },
      ],
      max_tokens: config.CLOUD_MAX_TOKENS,
    };
    addOpenAiCompatibleTools(body, tools);
    return {
      provider: 'openrouter',
      model: config.OPENROUTER_MODEL,
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
        'x-title': 'Garbanzo',
      },
      body,
      parser: parseChatCompletionResponse,
    };
  }

  if (provider === 'anthropic') {
    if (!config.ANTHROPIC_API_KEY) return null;
    const body: Record<string, unknown> = {
      model: config.ANTHROPIC_MODEL,
      max_tokens: config.CLOUD_MAX_TOKENS,
      // The persona system prompt is static across calls; mark it cacheable so
      // repeat calls read it at ~10% of base input price (ignored by the API
      // when below the model's cache minimum, so it's safe to always request).
      system: config.ANTHROPIC_PROMPT_CACHING
        ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
        : systemPrompt,
      messages: [{ role: 'user', content: buildAnthropicUserContent(userMessage, visionImages) }],
    };
    addAnthropicTools(body, tools);
    return {
      provider: 'anthropic',
      model: config.ANTHROPIC_MODEL,
      endpoint: 'https://api.anthropic.com/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body,
      parser: parseAnthropicResponse,
    };
  }

  if (provider === 'gemini') {
    if (!config.GEMINI_API_KEY) return null;
    return {
      provider: 'gemini',
      model: config.GEMINI_MODEL,
      endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${config.GEMINI_MODEL}:generateContent`,
      headers: {
        'content-type': 'application/json',
        // Key in a header, not the URL query string, so it does not leak into logs/proxies.
        'x-goog-api-key': config.GEMINI_API_KEY,
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
  if (isOpenAiReasoningModel(config.OPENAI_MODEL)) {
    const body: Record<string, unknown> = {
      model: config.OPENAI_MODEL,
      instructions: systemPrompt,
      input: [{
        role: 'user',
        content: buildOpenAIResponsesUserContent(userMessage, visionImages),
      }],
      max_output_tokens: config.CLOUD_MAX_TOKENS,
      reasoning: { effort: config.OPENAI_REASONING_EFFORT },
      store: false,
    };
    addOpenAiResponsesTools(body, tools);
    return {
      provider: 'openai',
      model: config.OPENAI_MODEL,
      endpoint: 'https://api.openai.com/v1/responses',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.OPENAI_API_KEY}`,
      },
      body,
      parser: parseResponsesApiResponse,
    };
  }

  const body: Record<string, unknown> = {
    model: config.OPENAI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildOpenAICompatibleUserContent(userMessage, visionImages) },
    ],
    max_tokens: config.CLOUD_MAX_TOKENS,
  };
  addOpenAiCompatibleTools(body, tools);
  return {
    provider: 'openai',
    model: config.OPENAI_MODEL,
    endpoint: 'https://api.openai.com/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.OPENAI_API_KEY}`,
    },
    body,
    parser: parseChatCompletionResponse,
  };
}

/**
 * OpenAI reasoning-model detection (GPT-5 family and o-series): these models
 * take max_completion_tokens + reasoning_effort instead of max_tokens on
 * chat/completions. Applies only to the direct api.openai.com path — the
 * OpenRouter path keeps max_tokens (OpenRouter normalizes params per vendor).
 */
export function isOpenAiReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model);
}

/** EXPERIMENTAL: ChatGPT-subscription backend used by OpenAI OAuth mode. */
const OPENAI_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/wham/responses';

const ResponsesApiSchema = z.object({
  output_text: z.union([z.string(), z.array(z.string())]).optional(),
  output: z.array(z.object({
    type: z.string().optional(),
    call_id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
    content: z.array(z.object({
      type: z.string().optional(),
      text: z.string().optional(),
    })).optional(),
  })).optional(),
});

/**
 * Build the OpenAI Responses-API request for OAuth ("Sign in with ChatGPT")
 * mode (EXPERIMENTAL, ToS-grey; verified against a live token 2026-07-02).
 * Targets the private ChatGPT backend with a fresh bearer token + account
 * header. Distinct from the apikey chat/completions request: content type is
 * `input_text`, the system prompt is passed as `instructions`, `store` is
 * false, and the backend REQUIRES `stream: true` (a non-streaming request is
 * rejected with 400 "Stream must be set to true") — perform this request with
 * performSseRequest, not performHttpRequest.
 */
export function buildOpenAIResponsesRequest(
  systemPrompt: string,
  userMessage: string,
  visionImages: VisionImage[] | undefined,
  accessToken: string,
  accountId: string | null,
): ProviderRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
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
      input: [{ role: 'user', content: buildOpenAIResponsesUserContent(userMessage, visionImages) }],
      store: false,
      stream: true,
    },
    parser: parseResponsesApiResponse,
  };
}

const SseEventSchema = z.object({
  type: z.string(),
  delta: z.string().optional(),
  response: z.unknown().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});

/**
 * Transport for SSE-only endpoints (the ChatGPT /wham Responses backend).
 * Accumulates `response.output_text.delta` events; on `response.completed`
 * prefers the final response object (the shape parseResponsesApiResponse
 * expects) over the accumulated deltas. `response.failed`/`error` events and
 * a stream that ends without any output text both throw, so the shared
 * caller records the failure and the router falls back to the next provider.
 */
export async function performSseRequest(req: ProviderRequest, signal: AbortSignal): Promise<string> {
  const response = await fetch(req.endpoint, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal,
  });

  if (!response.ok || !response.body) {
    const errorText = response.body ? await response.text() : '(no body)';
    throw new Error(`${req.provider} API error ${response.status}: ${errorText}`);
  }

  let buffer = '';
  let accumulated = '';
  let finalText: string | null = null;

  const handleEvent = (rawEvent: string): void => {
    // An SSE event may spread its payload over multiple `data:` lines.
    const dataPayload = rawEvent
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');
    if (!dataPayload || dataPayload === '[DONE]') return;

    let event: z.infer<typeof SseEventSchema>;
    try {
      event = SseEventSchema.parse(JSON.parse(dataPayload));
    } catch {
      return; // unrecognized event payload — skip
    }

    if (event.type === 'response.output_text.delta' && event.delta) {
      accumulated += event.delta;
      return;
    }
    if (event.type === 'response.completed' && event.response !== undefined) {
      try {
        const parsedFinal = parseResponsesApiResponse(event.response);
        finalText = parsedFinal;
      } catch {
        finalText = null; // fall back to accumulated deltas
      }
      return;
    }
    if (event.type === 'response.failed' || event.type === 'error') {
      throw new Error(`${req.provider} stream reported failure: ${event.error?.message ?? event.type}`);
    }
  };

  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let sep = buffer.indexOf('\n\n');
    while (sep >= 0) {
      handleEvent(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
      sep = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim()) handleEvent(buffer);

  const text = (finalText ?? accumulated).trim();
  if (!text) {
    throw new Error(`${req.provider} stream ended without producing output text`);
  }
  return text;
}

function parseResponsesApiResponse(data: unknown): string {
  const parsed = ResponsesApiSchema.safeParse(data);
  // A malformed HTTP-200 payload (backend error object or response-shape drift)
  // must NOT be treated as a successful reply — throw so the shared caller records
  // the failure and the router falls back to the next provider in AI_PROVIDER_ORDER.
  // The schema is permissive (all fields optional), so a body carrying neither
  // output text nor function calls (e.g. `{ error: 'temporarily_unavailable' }`)
  // is drift, not a successful empty reply.
  if (!parsed.success || (parsed.data.output_text === undefined && parsed.data.output === undefined)) {
    throw new Error('OpenAI Responses payload did not match expected shape');
  }

  if (typeof parsed.data.output_text === 'string') {
    const text = parsed.data.output_text.trim();
    if (text) return text;
  }
  if (Array.isArray(parsed.data.output_text)) {
    const text = parsed.data.output_text.join('').trim();
    if (text) return text;
  }

  const texts: string[] = [];
  let hasFunctionCalls = false;
  for (const item of parsed.data.output ?? []) {
    if (item.type === 'function_call') hasFunctionCalls = true;
    for (const block of item.content ?? []) {
      if (block.type === 'output_text' && block.text) texts.push(block.text);
    }
  }
  const text = texts.join('').trim();
  if (text) return text;
  if (hasFunctionCalls) return 'No response generated.';
  throw new Error('OpenAI Responses payload did not include output text or function calls');
}

/**
 * Standard HTTP transport for fetch-based providers (openrouter/anthropic/openai
 * API-key mode). Posts the built request under the caller's abort signal, maps a
 * non-2xx to `"<provider> API error <status>: <body>"`, and runs the parser.
 * (Gemini keeps its own perform to preserve its non-JSON error message.)
 */
export async function performJsonRequest(req: ProviderRequest, signal: AbortSignal): Promise<unknown> {
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

  return await response.json() as unknown;
}

export async function performHttpRequest(req: ProviderRequest, signal: AbortSignal): Promise<string> {
  const data = await performJsonRequest(req, signal);
  return req.parser(data);
}

function addOpenAiCompatibleTools(body: Record<string, unknown>, tools: AiTool[] | undefined): void {
  if (!tools || tools.length === 0) return;
  body.tools = tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function addOpenAiResponsesTools(body: Record<string, unknown>, tools: AiTool[] | undefined): void {
  if (!tools || tools.length === 0) return;
  body.tools = tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function addAnthropicTools(body: Record<string, unknown>, tools: AiTool[] | undefined): void {
  if (!tools || tools.length === 0) return;
  body.tools = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
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

function buildOpenAIResponsesUserContent(
  text: string,
  images: VisionImage[] | undefined,
): OpenAIResponsesContentBlock[] {
  const blocks: OpenAIResponsesContentBlock[] = [];
  if (images && images.length > 0) {
    for (const img of images) {
      blocks.push({
        type: 'input_image',
        image_url: `data:${img.mediaType};base64,${img.base64}`,
      });
    }
  }

  blocks.push({
    type: 'input_text',
    text: text || 'What do you see in this image? Describe it and respond naturally.',
  });
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
