import { logger } from '../../middleware/logger.js';

import { createDiscordAdapter } from './adapter.js';
import { getDiscordIntroductionsChannelId } from './discord-config.js';
import { processDiscordEvent } from './processor.js';
import { buildDiscordWelcomeMessage } from './welcome.js';

type DiscordEventHandler = (payload?: unknown) => void | Promise<void>;

export interface DiscordClientLike {
  on(event: string, handler: DiscordEventHandler): this;
  once(event: string, handler: DiscordEventHandler): this;
  login(token: string): Promise<string>;
  destroy(): Promise<void> | void;
  user: { id?: string | null } | null;
}

export interface DiscordGatewayClientDeps {
  token: string;
  ownerId: string;
  ownerUserId?: string;
  clientFactory?: () => DiscordClientLike;
}

interface DiscordMessagePayload {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: {
    id: string;
    bot: boolean;
  };
  timestamp: string;
  mentions: Array<{ id: string }>;
  referenced_message?: {
    id?: string;
    content?: string;
  };
  senderRoleIds: string[];
  attachments: unknown[];
  audio?: { url: string; contentType: string };
}

type DiscordClientConstructor = new (options: { intents: unknown[] }) => DiscordClientLike;

interface DiscordJsModule {
  Client: DiscordClientConstructor;
  GatewayIntentBits: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readNestedString(record: Record<string, unknown>, key: string, nestedKey: string): string | undefined {
  const nested = readRecord(record, key);
  return nested ? readString(nested, nestedKey) : undefined;
}

function readTimestamp(record: Record<string, unknown>): string {
  const timestamp = readString(record, 'timestamp');
  if (timestamp) return timestamp;

  const createdAt = record.createdAt;
  if (createdAt instanceof Date) return createdAt.toISOString();
  if (typeof createdAt === 'string') {
    const parsed = Date.parse(createdAt);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }

  const createdTimestamp = record.createdTimestamp;
  if (typeof createdTimestamp === 'number' && Number.isFinite(createdTimestamp)) {
    return new Date(createdTimestamp).toISOString();
  }

  return new Date().toISOString();
}

function readIterable(value: unknown): Iterable<unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const iterator = (value as { [Symbol.iterator]?: unknown })[Symbol.iterator];
  return typeof iterator === 'function' ? value as Iterable<unknown> : undefined;
}

function readCollectionKeys(value: unknown): unknown[] {
  if (!isRecord(value)) return [];
  const keys = value.keys;
  if (typeof keys !== 'function') return [];

  const result = (keys as (this: unknown) => unknown).call(value);
  const iterable = readIterable(result);
  return iterable ? Array.from(iterable) : [];
}

function readCollectionValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;

  if (!isRecord(value)) return [];
  const values = value.values;
  if (typeof values !== 'function') return [];

  const result = (values as (this: unknown) => unknown).call(value);
  const iterable = readIterable(result);
  return iterable ? Array.from(iterable) : [];
}

function readMentions(message: Record<string, unknown>): Array<{ id: string }> {
  const mentions = readRecord(message, 'mentions');
  const users = mentions?.users;
  if (!users) return [];

  const ids = readCollectionKeys(users)
    .filter((id): id is string => typeof id === 'string');

  if (ids.length > 0) {
    return ids.map((id) => ({ id }));
  }

  return readCollectionValues(users)
    .map((user) => isRecord(user) ? readString(user, 'id') : undefined)
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id }));
}

function readMemberRoleIds(message: Record<string, unknown>): string[] {
  const member = readRecord(message, 'member');
  if (!member) return [];

  const roles = member.roles;
  if (Array.isArray(roles)) {
    return roles.filter((roleId): roleId is string => typeof roleId === 'string');
  }

  if (!isRecord(roles)) return [];

  const cache = roles.cache;
  const ids = readCollectionKeys(cache).filter((roleId): roleId is string => typeof roleId === 'string');
  if (ids.length > 0) return ids;

  return readCollectionKeys(roles).filter((roleId): roleId is string => typeof roleId === 'string');
}

function readReferencedMessage(message: Record<string, unknown>): DiscordMessagePayload['referenced_message'] {
  const referencedMessage = readRecord(message, 'referencedMessage');
  const reference = readRecord(message, 'reference');
  const id = referencedMessage
    ? readString(referencedMessage, 'id')
    : reference
      ? readString(reference, 'messageId') ?? readString(reference, 'message_id')
      : undefined;
  const content = referencedMessage ? readString(referencedMessage, 'content') : undefined;

  if (!id && !content) return undefined;
  return {
    ...(id ? { id } : {}),
    ...(content ? { content } : {}),
  };
}

const AUDIO_EXTENSION_CONTENT_TYPES: Record<string, string> = {
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

function inferAudioContentTypeFromName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  const extension = Object.keys(AUDIO_EXTENSION_CONTENT_TYPES).find((ext) => lower.endsWith(ext));
  return extension ? AUDIO_EXTENSION_CONTENT_TYPES[extension] : undefined;
}

function readAudioAttachment(attachments: unknown[]): { url: string; contentType: string } | undefined {
  for (const attachment of attachments) {
    if (!isRecord(attachment)) continue;

    const url = readString(attachment, 'url');
    if (!url) continue;

    const declaredContentType = readString(attachment, 'contentType') ?? readString(attachment, 'content_type');
    const filename = readString(attachment, 'name') ?? readString(attachment, 'filename');
    const isDeclaredAudio = declaredContentType?.startsWith('audio/') ?? false;
    const inferredContentType = inferAudioContentTypeFromName(filename) ?? inferAudioContentTypeFromName(url);

    if (isDeclaredAudio) {
      return { url, contentType: declaredContentType! };
    }

    if (inferredContentType) {
      return { url, contentType: declaredContentType ?? inferredContentType };
    }
  }

  return undefined;
}

export function mapMessageToPayload(message: unknown): DiscordMessagePayload {
  const record = isRecord(message) ? message : {};
  const author = readRecord(record, 'author') ?? {};
  const guildId = readString(record, 'guildId')
    ?? readString(record, 'guild_id')
    ?? readNestedString(record, 'guild', 'id');
  const referencedMessage = readReferencedMessage(record);
  const attachments = readCollectionValues(record.attachments);
  const audio = readAudioAttachment(attachments);

  return {
    id: readString(record, 'id') ?? '',
    channel_id: readString(record, 'channelId')
      ?? readString(record, 'channel_id')
      ?? readNestedString(record, 'channel', 'id')
      ?? '',
    ...(guildId ? { guild_id: guildId } : {}),
    content: readString(record, 'content') ?? '',
    author: {
      id: readString(author, 'id') ?? '',
      bot: readBoolean(author, 'bot') ?? false,
    },
    timestamp: readTimestamp(record),
    mentions: readMentions(record),
    ...(referencedMessage ? { referenced_message: referencedMessage } : {}),
    senderRoleIds: readMemberRoleIds(record),
    attachments,
    ...(audio ? { audio } : {}),
  };
}

async function defaultClientFactory(): Promise<DiscordClientLike> {
  const discordJsModuleName = 'discord.js';
  const { Client, GatewayIntentBits } = await import(discordJsModuleName) as unknown as DiscordJsModule;
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessageReactions,
    ],
  }) as DiscordClientLike;
}

function readMemberUserId(member: unknown): string | null {
  if (!isRecord(member)) return null;
  const user = readRecord(member, 'user');
  return user
    ? readString(user, 'id') ?? null
    : readString(member, 'id') ?? null;
}

function readMemberDisplayName(member: unknown): string | undefined {
  if (!isRecord(member)) return undefined;
  const user = readRecord(member, 'user');
  return readString(member, 'displayName') ?? (user ? readString(user, 'username') : undefined);
}

export function createDiscordGatewayClient(deps: DiscordGatewayClientDeps): {
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  const adapter = createDiscordAdapter(deps.token);
  let client = deps.clientFactory?.();
  let botUserId: string | undefined;

  async function getClient(): Promise<DiscordClientLike> {
    client ??= await defaultClientFactory();
    return client;
  }

  async function handleMessageCreate(message: unknown): Promise<void> {
    try {
      const payload = mapMessageToPayload(message);
      if (payload.author.bot) return;

      await processDiscordEvent(adapter, payload, {
        ownerId: deps.ownerId,
        ownerUserId: deps.ownerUserId,
        botUserId,
      });
    } catch (err) {
      logger.error({ err }, 'Discord messageCreate handler failed');
    }
  }

  async function handleGuildMemberAdd(member: unknown): Promise<void> {
    try {
      const channelId = getDiscordIntroductionsChannelId();
      if (!channelId) return;

      const memberUserId = readMemberUserId(member);
      if (!memberUserId) return;

      const welcome = buildDiscordWelcomeMessage({
        channelId,
        memberUserId,
        memberDisplayName: readMemberDisplayName(member),
      });

      await adapter.sendText(channelId, welcome);
    } catch (err) {
      logger.error({ err }, 'Discord guildMemberAdd handler failed');
    }
  }

  async function handleReady(): Promise<void> {
    try {
      const discordClient = await getClient();
      const nextBotUserId = discordClient.user?.id ?? undefined;
      if (botUserId === nextBotUserId) return;

      botUserId = nextBotUserId;
      logger.info({ botUserId }, 'Discord Gateway client ready');
    } catch (err) {
      logger.error({ err }, 'Discord ready handler failed');
    }
  }

  return {
    async start(): Promise<void> {
      const discordClient = await getClient();
      discordClient.on('messageCreate', handleMessageCreate);
      discordClient.on('guildMemberAdd', handleGuildMemberAdd);
      discordClient.once('clientReady', handleReady);
      discordClient.once('ready', handleReady);
      await discordClient.login(deps.token);
    },

    async stop(): Promise<void> {
      const discordClient = await getClient();
      await discordClient.destroy();
    },
  };
}
