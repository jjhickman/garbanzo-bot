import { z } from 'zod';
import { booleanFromEnv, optionalString } from './shared.js';

export const aiSchema = z.object({
  // AI — at least one must be set
  ANTHROPIC_API_KEY: optionalString,
  OPENROUTER_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,
  GEMINI_API_KEY: optionalString,
  // Comma-separated provider priority order, eg: "openrouter,anthropic,openai,gemini,bedrock"
  AI_PROVIDER_ORDER: z.string().default('openai,anthropic'),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  // Anthropic pricing (USD per 1M tokens) for cost tracking — default: Claude Haiku 4.5 ($1/$5).
  ANTHROPIC_PRICING_INPUT_PER_M: z.coerce.number().min(0).default(1.0),
  ANTHROPIC_PRICING_OUTPUT_PER_M: z.coerce.number().min(0).default(5.0),
  // Cache the (static) persona system prompt so repeat calls read it at 10% of input price.
  ANTHROPIC_PROMPT_CACHING: booleanFromEnv.default(true),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-sonnet-4-5'),
  OPENAI_MODEL: z.string().default('gpt-5.4-mini'),
  // Reasoning depth for GPT-5-series/o-series chat models. 'low' keeps chat
  // replies cheap and fast; raise only if answers feel shallow.
  OPENAI_REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high']).default('low'),
  // OpenAI pricing (USD per 1M tokens) for cost tracking — default: gpt-5.4-mini ($0.75/$4.50).
  OPENAI_PRICING_INPUT_PER_M: z.coerce.number().min(0).default(0.75),
  OPENAI_PRICING_OUTPUT_PER_M: z.coerce.number().min(0).default(4.5),
  // apikey (default): api.openai.com with OPENAI_API_KEY. oauth (EXPERIMENTAL,
  // ToS-grey): "Sign in with ChatGPT" via `npm run openai:login`, calls the
  // ChatGPT backend. Always falls back to the next provider on failure.
  OPENAI_AUTH_MODE: z.enum(['apikey', 'oauth']).default('apikey'),
  GEMINI_MODEL: z.string().default('gemini-1.5-flash'),
  GEMINI_PRICING_INPUT_PER_M: z.coerce.number().min(0).default(0.0),
  GEMINI_PRICING_OUTPUT_PER_M: z.coerce.number().min(0).default(0.0),
  CLOUD_MAX_TOKENS: z.coerce.number().int().min(64).max(4096).default(1024),
  CLOUD_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  RETRY_ATTEMPT_TIMEOUT_MS: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.coerce.number().int().min(1000).max(120000).optional(),
  ),
  AI_TOOL_CALLING: booleanFromEnv.default(false),
  AI_TOOL_MAX_ITERATIONS: z.coerce.number().int().min(1).max(5).default(3),

  // AWS Bedrock (uses AWS credentials via default provider chain)
  BEDROCK_REGION: z.string().default('us-east-1'),
  BEDROCK_MODEL_ID: optionalString,
  BEDROCK_MAX_TOKENS: z.coerce.number().int().min(1).max(4096).default(1024),
  BEDROCK_PRICING_INPUT_PER_M: z.coerce.number().min(0).default(0.0),
  BEDROCK_PRICING_OUTPUT_PER_M: z.coerce.number().min(0).default(0.0),

  // Ollama (local, optional)
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default('qwen3:8b'),
});
