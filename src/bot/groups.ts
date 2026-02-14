import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PROJECT_ROOT } from '../utils/config.js';

interface GroupConfig {
  name: string;
  enabled: boolean;
  requireMention: boolean;
  /** Optional feature allowlist. If omitted or empty, all features are enabled. */
  enabledFeatures?: string[];
  /** Optional per-group persona hint appended to the system prompt */
  persona?: string;
}

interface GroupsConfig {
  groups: Record<string, GroupConfig>;
  mentionPatterns: string[];
  admins: {
    owner: { name: string; jid: string };
    moderators: { name: string }[];
  };
}

// Load group config from JSON
const configPath = resolve(PROJECT_ROOT, 'config', 'groups.json');
const groupsConfig: GroupsConfig = JSON.parse(
  readFileSync(configPath, 'utf-8'),
);

/** All configured group JIDs */
export const GROUP_IDS = groupsConfig.groups;

/** Mention patterns that trigger the bot */
export const MENTION_PATTERNS = groupsConfig.mentionPatterns;

/** Admin contacts */
export const ADMINS = groupsConfig.admins;

/** Check if a group is enabled */
export function isGroupEnabled(jid: string): boolean {
  return GROUP_IDS[jid]?.enabled ?? false;
}

/** Get the human-readable name for a group JID */
export function getGroupName(jid: string): string {
  return GROUP_IDS[jid]?.name ?? 'Unknown Group';
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

/** Extract the bare identifier (without device suffix or domain) from a JID or LID */
function bareId(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

/**
 * Check if the bot is mentioned — either via WhatsApp's native JID-based
 * mention system (contextInfo.mentionedJid) or via text pattern fallback.
 *
 * WhatsApp is migrating to LIDs (Linked IDs) — mentions may arrive as
 * either `phone@s.whatsapp.net` or `lid@lid`. We check both.
 */
export function isMentioned(
  text: string,
  mentionedJids?: string[],
  botJid?: string,
  botLid?: string,
): boolean {
  // Primary: check WhatsApp's native mention (JID or LID based)
  if (mentionedJids?.length) {
    const botIds = [botJid, botLid].filter(Boolean).map((id) => bareId(id!));
    if (mentionedJids.some((jid) => botIds.includes(bareId(jid)))) {
      return true;
    }
  }

  // Fallback: text pattern matching (for users who type "@garbanzo" manually)
  const lower = text.toLowerCase();
  return MENTION_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

/**
 * Strip mention artifacts from the message text.
 * Handles native @mentions (which appear as @phonenumber or @lid) and
 * text-based patterns like "@garbanzo".
 */
export function stripMention(text: string, botJid?: string, botLid?: string): string {
  let result = text;

  // Strip native WhatsApp mention formats (@phonenumber or @lid)
  for (const id of [botJid, botLid].filter(Boolean)) {
    const num = bareId(id!);
    const idRegex = new RegExp(`@${num}\\b`, 'g');
    result = result.replace(idRegex, '').trim();
  }

  // Strip text-based patterns
  for (const pattern of MENTION_PATTERNS) {
    const regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    result = result.replace(regex, '').trim();
  }
  return result;
}
