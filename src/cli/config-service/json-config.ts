import { z, type ZodType } from 'zod';

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

const schemas: Record<Exclude<ConfigFileName, 'bridge-map'>, ZodType> = {
  groups: groupsSchema,
  'discord-channels': discordChannelsSchema,
  'telegram-chats': telegramChatsSchema,
  'matrix-rooms': matrixRoomsSchema,
  'rag-sources': ragSourcesSchema,
};

export function isConfigFileName(value: string): value is ConfigFileName {
  return CONFIG_FILE_NAMES.includes(value as ConfigFileName);
}

export function validateConfigFile(name: ConfigFileName, value: unknown): z.ZodIssue[] {
  if (name === 'bridge-map') return [];
  const result = schemas[name].safeParse(value);
  return result.success ? [] : result.error.issues;
}

const PUBLIC_JSON_KEYS = new Set([
  '_comment', '_comment_embedding_models', 'groups', 'mentionPatterns', 'admins', 'owner', 'moderators',
  'name', 'jid', 'enabled', 'requireMention', 'enabledFeatures', 'persona', 'ownerId', 'bandRoleIds',
  'introductionsChannelId', 'eventsChannelId', 'channels', 'features', 'chats', 'rooms', 'alias', 'sources',
  'id', 'label', 'collection', 'textField', 'embedding', 'provider', 'model', 'dimensions', 'maxHits',
  'minScore', 'instances', 'routes', 'platform', 'direction', 'from', 'modeToWhatsApp', 'modeToDiscord',
  'relayCommands', 'ingestRelayed', 'instance', 'chatId',
]);

function urlHasCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return !!url.username || !!url.password || [...url.searchParams.keys()].some((key) => /token|key|secret|pass/i.test(key));
  } catch {
    return false;
  }
}

export function maskJsonSecrets(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => maskJsonSecrets(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, maskJsonSecrets(child, childKey)]));
  }
  const secretKey = !PUBLIC_JSON_KEYS.has(key) || /api.?key|token|secret|password/i.test(key);
  if (secretKey) return { set: value !== null && value !== undefined && value !== '' };
  if (typeof value === 'string' && urlHasCredentials(value)) return { set: value.length > 0 };
  return value;
}

export function zodIssues(issues: z.ZodIssue[]): Array<{ code: string; path: PropertyKey[]; message: string }> {
  return issues.map((issue) => ({ code: issue.code, path: issue.path, message: issue.message }));
}
