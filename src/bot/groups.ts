import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PROJECT_ROOT } from '../utils/config.js';

interface GroupConfig {
  name: string;
  enabled: boolean;
  requireMention: boolean;
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

/** Check if text contains a mention of the bot */
export function isMentioned(text: string): boolean {
  const lower = text.toLowerCase();
  return MENTION_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

/** Strip the mention pattern from the beginning of the message */
export function stripMention(text: string): string {
  let result = text;
  for (const pattern of MENTION_PATTERNS) {
    const regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    result = result.replace(regex, '').trim();
  }
  return result;
}
