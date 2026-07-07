import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

import { logger } from '../middleware/logger.js';
import { config, PROJECT_ROOT } from './config.js';

const RAG_SOURCES_PATH = resolve(PROJECT_ROOT, 'config/rag-sources.json');

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().url().optional(),
);

const EmbeddingSchema = z.object({
  provider: z.enum(['openai', 'deterministic']),
  model: optionalNonEmptyString,
  dimensions: z.coerce.number().int().min(1).optional(),
}).strict();

const RagSourceSchema = z.object({
  _comment: z.string().optional(),
  id: z.string().min(1),
  label: z.string().min(1),
  url: optionalUrl,
  apiKey: optionalNonEmptyString,
  collection: z.string().min(1),
  textField: z.string().min(1).default('text'),
  embedding: EmbeddingSchema,
  maxHits: z.coerce.number().int().min(1).max(10).default(3),
  minScore: z.coerce.number().min(0).max(1).default(0.35),
  chats: z.array(z.string().min(1)).optional(),
  enabled: z.boolean().default(true),
}).strict();

export const RagSourcesConfigSchema = z.object({
  _comment: z.string().optional(),
  _comment_embedding_models: z.string().optional(),
  sources: z.array(RagSourceSchema),
}).strict().superRefine((cfg, ctx) => {
  const ids = new Set<string>();
  for (const [index, source] of cfg.sources.entries()) {
    if (ids.has(source.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sources', index, 'id'],
        message: `Duplicate RAG source id: ${source.id}`,
      });
    }
    ids.add(source.id);
  }
});

export type RagSource = z.infer<typeof RagSourceSchema> & {
  url: string;
  apiKey: string | undefined;
};
export type RagSourcesConfig = {
  sources: RagSource[];
};

let loadedRagSources: RagSourcesConfig | null | undefined;

function applySourceDefaults(source: z.infer<typeof RagSourceSchema>): RagSource {
  return {
    ...source,
    url: source.url ?? config.QDRANT_URL,
    apiKey: source.apiKey ?? config.QDRANT_API_KEY,
  };
}

export function loadRagSources(): RagSourcesConfig | null {
  if (loadedRagSources !== undefined) return loadedRagSources;

  if (!existsSync(RAG_SOURCES_PATH)) {
    logger.warn({ path: RAG_SOURCES_PATH }, 'RAG sources config file not found; federation disabled');
    loadedRagSources = null;
    return loadedRagSources;
  }

  try {
    const raw = JSON.parse(readFileSync(RAG_SOURCES_PATH, 'utf8')) as unknown;
    const parsed = RagSourcesConfigSchema.parse(raw);
    loadedRagSources = {
      sources: parsed.sources.map(applySourceDefaults),
    };
    return loadedRagSources;
  } catch (err) {
    logger.warn({ err, path: RAG_SOURCES_PATH }, 'Failed to load RAG sources config; federation disabled');
    loadedRagSources = null;
    return loadedRagSources;
  }
}
