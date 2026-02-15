import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { PROJECT_ROOT } from '../utils/config.js';

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

// Load and validate group config from JSON at startup
const configPath = resolve(PROJECT_ROOT, 'config', 'groups.json');
const groupsConfig = GroupsConfigSchema.parse(
  JSON.parse(readFileSync(configPath, 'utf-8')),
);

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
