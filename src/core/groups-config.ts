import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

import { logger } from '../middleware/logger.js';
import { homePath } from '../utils/paths.js';

// ── Zod schema for config/groups.json ───────────────────────────────

const GroupConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  requireMention: z.boolean(),
  enabledFeatures: z.array(z.string()).optional(),
  persona: z.string().optional(),
});

const GroupsConfigSchema = z.object({
  // Zod v4 requires both key and value schemas for records.
  groups: z.record(z.string(), GroupConfigSchema),
  mentionPatterns: z.array(z.string()),
  admins: z.object({
    owner: z.object({ name: z.string(), jid: z.string() }),
    moderators: z.array(z.object({ name: z.string() })),
  }),
});

type GroupsConfig = z.infer<typeof GroupsConfigSchema>;

const DEFAULT_GROUPS_CONFIG: GroupsConfig = {
  groups: {},
  mentionPatterns: [],
  admins: {
    owner: { name: '', jid: '' },
    moderators: [],
  },
};

function errorReason(err: unknown): string {
  if (err instanceof z.ZodError) {
    return `schema validation failed: ${err.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')}`;
  }

  if (err instanceof Error) return err.message.replace(/\s+/g, ' ');

  return String(err).replace(/\s+/g, ' ');
}

const configPath = homePath('config', 'groups.json');

function loadGroupsConfig(): GroupsConfig {
  if (!existsSync(configPath)) {
    logger.warn({ path: configPath }, 'Groups config file not found; using empty groups config');
    return DEFAULT_GROUPS_CONFIG;
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
    return GroupsConfigSchema.parse(raw);
  } catch (err) {
    logger.error(
      { path: configPath, reason: errorReason(err) },
      'Failed to load groups config; using empty groups config',
    );
    return DEFAULT_GROUPS_CONFIG;
  }
}

const groupsConfig = loadGroupsConfig();

/** All configured group JIDs */
export const GROUP_IDS = groupsConfig.groups;

/** Mention patterns that trigger the bot */
export const MENTION_PATTERNS = groupsConfig.mentionPatterns;

/** Check if a group is enabled */
export function isGroupEnabled(jid: string): boolean {
  return GROUP_IDS[jid]?.enabled ?? false;
}

/** Get the human-readable name for a group JID */
export function getGroupName(jid: string): string {
  return GROUP_IDS[jid]?.name ?? 'Unknown Group';
}

/**
 * Platform-registered fallback for resolving a chat id to a display name.
 * groups.json only knows WhatsApp group JIDs, so Discord channel ids (and
 * Telegram chat / Matrix room ids) rendered as "Unknown Group" in digests
 * and recaps. Core must not import platform config (see the band-features
 * decision), so each platform runtime registers its own resolver at startup.
 */
type ChatNameResolver = (chatId: string) => string | undefined;

let chatNameResolver: ChatNameResolver | null = null;

export function registerChatNameResolver(resolver: ChatNameResolver): void {
  chatNameResolver = resolver;
}

/**
 * Resolve a chat id to a display name for stats surfaces (digest, recap):
 * groups.json first, then the active platform's registered resolver, then
 * the legacy 'Unknown Group' fallback.
 */
export function getChatDisplayName(chatId: string): string {
  const configured = GROUP_IDS[chatId]?.name;
  if (configured) return configured;
  const resolved = chatNameResolver?.(chatId);
  return resolved !== undefined && resolved.length > 0 ? resolved : 'Unknown Group';
}

/**
 * Find an enabled group JID by its configured name.
 * Returns null if not found or not enabled.
 */
export function getEnabledGroupJidByName(name: string): string | null {
  for (const [jid, cfg] of Object.entries(GROUP_IDS)) {
    if (cfg.name === name && cfg.enabled) return jid;
  }
  return null;
}

/** Check if a group requires @mention to respond */
export function requiresMention(jid: string): boolean {
  return GROUP_IDS[jid]?.requireMention ?? true;
}

/**
 * Get the per-group persona hint, if any.
 * Returns undefined if no custom persona is configured for this group.
 */
export function getGroupPersona(jid: string): string | undefined {
  return GROUP_IDS[jid]?.persona;
}

/**
 * Check if a specific feature is enabled for a group.
 * If the group has no `enabledFeatures` array (or it's empty), all features are allowed.
 * If it has a list, only those features work in that group.
 */
export function isFeatureEnabled(jid: string, feature: string): boolean {
  const group = GROUP_IDS[jid];
  if (!group) return true; // Unknown group — allow (DMs, etc.)
  if (!group.enabledFeatures || group.enabledFeatures.length === 0) return true;
  return group.enabledFeatures.includes(feature);
}
