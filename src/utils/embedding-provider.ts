import { z } from 'zod';
import { logger } from '../middleware/logger.js';
import { config } from './config.js';
import { embedTextDeterministic } from './text-embedding.js';

export type VectorEmbeddingProvider = 'deterministic' | 'openai';

export interface EmbeddingResult {
  vector: number[];
  provider: VectorEmbeddingProvider;
  model: string;
  latencyMs: number;
  usedFallback: boolean;
}

const OpenAiEmbeddingResponseSchema = z.object({
  data: z.array(z.object({
    embedding: z.array(z.number()),
  })).min(1),
});

let loggedMissingOpenAiKey = false;
let loggedOpenAiFailure = false;

function deterministicResult(text: string, dimensions: number, latencyMs: number, usedFallback: boolean): EmbeddingResult {
  return {
    vector: embedTextDeterministic(text, dimensions),
    provider: 'deterministic',
    model: 'deterministic-hash-v1',
    latencyMs,
    usedFallback,
  };
}

function normalizeInput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'empty';
  if (trimmed.length <= config.VECTOR_EMBEDDING_MAX_CHARS) return trimmed;
  return trimmed.slice(0, config.VECTOR_EMBEDDING_MAX_CHARS);
}

export async function embedTextForVectorSearch(
  text: string,
  dimensions: number,
): Promise<EmbeddingResult> {
  const normalizedText = normalizeInput(text);
  const provider = config.VECTOR_EMBEDDING_PROVIDER;

  if (provider !== 'openai') {
    return deterministicResult(normalizedText, dimensions, 0, false);
  }

  if (!config.OPENAI_API_KEY) {
    if (!loggedMissingOpenAiKey) {
      logger.warn(
        'VECTOR_EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is missing; using deterministic embedding fallback',
      );
      loggedMissingOpenAiKey = true;
    }
    return deterministicResult(normalizedText, dimensions, 0, true);
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.VECTOR_EMBEDDING_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: config.VECTOR_EMBEDDING_MODEL,
        input: normalizedText,
        dimensions,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI embeddings failed with status ${response.status}`);
    }

    const data = OpenAiEmbeddingResponseSchema.parse(await response.json());
    const embedding = data.data[0]?.embedding ?? [];

    if (embedding.length !== dimensions) {
      throw new Error(
        `OpenAI embedding dimensions mismatch: expected ${dimensions}, got ${embedding.length}`,
      );
    }

    return {
      vector: embedding,
      provider: 'openai',
      model: config.VECTOR_EMBEDDING_MODEL,
      latencyMs: Date.now() - startedAt,
      usedFallback: false,
    };
  } catch (err) {
    if (!loggedOpenAiFailure) {
      logger.warn(
        { err },
        'OpenAI embedding request failed; falling back to deterministic embeddings',
      );
      loggedOpenAiFailure = true;
    }

    return deterministicResult(normalizedText, dimensions, Date.now() - startedAt, true);
  } finally {
    clearTimeout(timeout);
  }
}
