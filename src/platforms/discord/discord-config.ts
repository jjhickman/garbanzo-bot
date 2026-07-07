import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import { homePath } from '../../utils/paths.js';

const DiscordChannelConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  requireMention: z.boolean().default(true),
  features: z.array(z.string()).optional(),
  bandRoleIds: z.array(z.string()).optional(),
});

const DiscordChannelsConfigSchema = z.object({
  ownerId: z.string().optional(),
  bandRoleIds: z.array(z.string()).optional(),
  introductionsChannelId: z.string().optional(),
  eventsChannelId: z.string().optional(),
  channels: z.record(z.string(), DiscordChannelConfigSchema),
});

type DiscordChannelsConfig = z.infer<typeof DiscordChannelsConfigSchema>;

const DEFAULT_DISCORD_CHANNELS_CONFIG: DiscordChannelsConfig = {
  channels: {},
};

function resolveDiscordConfigPath(path: string): string {
  return isAbsolute(path) ? path : homePath(path);
}

function loadDiscordChannelsConfig(): DiscordChannelsConfig {
  const path = resolveDiscordConfigPath(config.DISCORD_CHANNELS_CONFIG_PATH);

  if (!existsSync(path)) {
    logger.warn({ path }, 'Discord channels config file not found; all channels disabled by default');
    return DEFAULT_DISCORD_CHANNELS_CONFIG;
  }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return DiscordChannelsConfigSchema.parse(raw);
  } catch (err) {
    logger.warn({ err, path }, 'Failed to load Discord channels config; all channels disabled by default');
    return DEFAULT_DISCORD_CHANNELS_CONFIG;
  }
}

const discordChannelsConfig = loadDiscordChannelsConfig();

export function getDiscordOwnerId(): string | undefined {
  return config.DISCORD_OWNER_ID ?? discordChannelsConfig.ownerId;
}

export function isDiscordChannelEnabled(channelId: string): boolean {
  return discordChannelsConfig.channels[channelId]?.enabled ?? false;
}

export function discordChannelRequiresMention(channelId: string): boolean {
  return discordChannelsConfig.channels[channelId]?.requireMention ?? true;
}

export function isDiscordFeatureEnabled(channelId: string, feature: string): boolean {
  const channel = discordChannelsConfig.channels[channelId];
  if (!channel || !channel.enabled) return false;
  if (channel.features === undefined) return true;
  return channel.features.includes(feature);
}

export function getDiscordChannelName(channelId: string): string | undefined {
  return discordChannelsConfig.channels[channelId]?.name;
}

export function isBandMember(roleIds: string[]): boolean {
  const bandRoleIds = new Set(discordChannelsConfig.bandRoleIds ?? []);
  return roleIds.some((roleId) => bandRoleIds.has(roleId));
}

export function getDiscordIntroductionsChannelId(): string | null {
  return discordChannelsConfig.introductionsChannelId ?? null;
}

export function getDiscordEventsChannelId(): string | null {
  return discordChannelsConfig.eventsChannelId ?? null;
}
