import { z, type ZodType } from 'zod';

import {
  BridgeMapSchema,
  describeBridgeMapIssue,
  expandBridgeMapEnvPlaceholders,
} from '../../bridge/bridge-map-schema.js';
export { maskJsonSecrets } from '../../config-core/secret-classifier.js';

export const CONFIG_FILE_NAMES = [
  'groups',
  'discord-channels',
  'telegram-chats',
  'matrix-rooms',
  'rag-sources',
  'bridge-map',
] as const;
export type ConfigFileName = (typeof CONFIG_FILE_NAMES)[number];

const chatEntry = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  requireMention: z.boolean().default(true),
  enabledFeatures: z.array(z.string()).optional(),
  persona: z.string().optional(),
});

const groupEntry = z.object({
  name: z.string(),
  enabled: z.boolean(),
  requireMention: z.boolean(),
  enabledFeatures: z.array(z.string()).optional(),
  persona: z.string().optional(),
});

// These two loaders currently keep their schemas module-private. The shapes
// are kept byte-for-byte equivalent here until those exports can move into
// config-core without crossing WS2's file boundary.
const groupsSchema = z.object({
  groups: z.record(z.string(), groupEntry),
  mentionPatterns: z.array(z.string()),
  admins: z.object({
    owner: z.object({ name: z.string(), jid: z.string() }),
    moderators: z.array(z.object({ name: z.string() })),
  }),
});

const discordChannelsSchema = z.object({
  ownerId: z.string().optional(),
  bandRoleIds: z.array(z.string()).optional(),
  introductionsChannelId: z.string().optional(),
  eventsChannelId: z.string().optional(),
  channels: z.record(z.string(), z.object({
    name: z.string(),
    enabled: z.boolean().default(true),
    requireMention: z.boolean().default(true),
    features: z.array(z.string()).optional(),
    bandRoleIds: z.array(z.string()).optional(),
  })),
});

const telegramChatsSchema = z.object({ ownerId: z.string().optional(), chats: z.record(z.string(), chatEntry) });
const matrixRoomsSchema = z.object({
  ownerId: z.string().optional(),
  rooms: z.record(z.string(), chatEntry.extend({ alias: z.string().optional() })),
});
const optionalNonEmptyString = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(1).optional(),
);
const optionalUrl = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().url().optional(),
);

const ragSourcesSchema = z.object({
  _comment: z.string().optional(),
  _comment_embedding_models: z.string().optional(),
  sources: z.array(z.object({
    _comment: z.string().optional(),
    id: z.string().min(1),
    label: z.string().min(1),
    url: optionalUrl,
    apiKey: optionalNonEmptyString,
    collection: z.string().min(1),
    textField: z.string().min(1).default('text'),
    embedding: z.object({
      provider: z.enum(['openai', 'deterministic']),
      model: optionalNonEmptyString,
      dimensions: z.coerce.number().int().min(1).optional(),
    }).strict(),
    maxHits: z.coerce.number().int().min(1).max(10).default(3),
    minScore: z.coerce.number().min(0).max(1).default(0.35),
    chats: z.array(z.string().min(1)).optional(),
    enabled: z.boolean().default(true),
  }).strict()),
}).strict().superRefine((config, context) => {
  const ids = new Set<string>();
  for (const [index, source] of config.sources.entries()) {
    if (ids.has(source.id)) {
      context.addIssue({ code: 'custom', path: ['sources', index, 'id'], message: `Duplicate RAG source id: ${source.id}` });
    }
    ids.add(source.id);
  }
});

const schemas: Record<ConfigFileName, ZodType> = {
  groups: groupsSchema,
  'discord-channels': discordChannelsSchema,
  'telegram-chats': telegramChatsSchema,
  'matrix-rooms': matrixRoomsSchema,
  'rag-sources': ragSourcesSchema,
  'bridge-map': BridgeMapSchema,
};

export function isConfigFileName(value: string): value is ConfigFileName {
  return CONFIG_FILE_NAMES.includes(value as ConfigFileName);
}

export function validateConfigFile(name: ConfigFileName, value: unknown): z.ZodIssue[] {
  let candidate = value;
  try {
    if (name === 'bridge-map') candidate = expandBridgeMapEnvPlaceholders(value);
  } catch (error) {
    return [{
      code: 'custom',
      path: [],
      message: error instanceof Error ? error.message : 'Bridge-map placeholder expansion failed',
    }];
  }

  const result = schemas[name].safeParse(candidate);
  if (result.success) return [];
  return name === 'bridge-map'
    ? result.error.issues.map((issue) => ({ ...issue, message: describeBridgeMapIssue(issue, value) }))
    : result.error.issues;
}

export function zodIssues(issues: z.ZodIssue[]): Array<{ code: string; path: PropertyKey[]; message: string }> {
  return issues.map((issue) => ({ code: issue.code, path: issue.path, message: issue.message }));
}
