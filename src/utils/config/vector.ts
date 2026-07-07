import { z } from 'zod';
import { optionalString } from './shared.js';

export const vectorSchema = z.object({
  // Vector embedding pipeline
  VECTOR_STORE: z.enum(['qdrant', 'none']).default('qdrant'),
  QDRANT_URL: z.string().url().default('http://127.0.0.1:6333'),
  QDRANT_API_KEY: optionalString,
  QDRANT_COLLECTION: z.string().min(1).default('garbanzo_memory'),
  VECTOR_EMBEDDING_PROVIDER: z.enum(['deterministic', 'openai']).default('openai'),
  VECTOR_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  VECTOR_EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(3072).default(1536),
  VECTOR_EMBEDDING_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(12000),
  VECTOR_EMBEDDING_MAX_CHARS: z.coerce.number().int().min(256).max(12000).default(4000),
});
