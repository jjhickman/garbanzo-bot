/**
 * Member profiles — opt-in interest tracking and activity stats.
 *
 * Commands:
 *   !profile            — view your profile
 *   !profile interests <comma-separated list> — set your interests
 *   !profile name <name> — set your display name
 *   !profile delete     — delete your profile data (opt-out)
 *
 * Passive tracking (for all members, opted-in or not):
 *   - First/last seen timestamps
 *   - Active groups
 *
 * Interest tracking + event counts only apply to opted-in members.
 */

import {
  touchProfile,
  getProfile,
  setProfileInterests,
  setProfileName,
  deleteProfileData,
  type MemberProfile,
} from '../utils/db.js';
import { getGroupName } from '../bot/groups.js';

/**
 * Handle !profile commands. Returns a response string.
 */
export function handleProfile(args: string, senderJid: string): string {
  const trimmed = args.trim().toLowerCase();

  // !profile delete — opt out and remove all data
  if (trimmed === 'delete' || trimmed === 'optout' || trimmed === 'opt-out') {
    deleteProfileData(senderJid);
    return '🗑️ Your profile data has been deleted.';
  }

  // !profile interests <list>
  if (trimmed === 'interests' || trimmed === 'interest') {
    return '❌ Provide comma-separated interests: `!profile interests hiking, cooking, board games`';
  }
  if (trimmed.startsWith('interests ') || trimmed.startsWith('interest ')) {
    const raw = args.trim().slice(args.trim().indexOf(' ') + 1);
    const interests = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (interests.length === 0) {
      return '❌ Provide comma-separated interests: `!profile interests hiking, cooking, board games`';
    }
    // Ensure profile exists
    touchProfile(senderJid);
    setProfileInterests(senderJid, interests);
    return `✅ Interests updated: ${interests.join(', ')}`;
  }

  // !profile name <name>
  if (trimmed.startsWith('name ')) {
    const name = args.trim().slice(5).trim();
    if (!name || name.length > 50) {
      return '❌ Provide a name (max 50 chars): `!profile name Alex`';
    }
    touchProfile(senderJid);
    setProfileName(senderJid, name);
    return `✅ Display name set to: ${name}`;
  }

  // !profile (no args) — view profile
  const profile = getProfile(senderJid);
  if (!profile) {
    return [
      '📋 *Your Profile*',
      '',
      'No profile yet. Set your interests to get started:',
      '  `!profile interests hiking, cooking, board games`',
      '  `!profile name YourName`',
      '',
      'Your data is opt-in. Use `!profile delete` to remove anytime.',
    ].join('\n');
  }

  return formatProfile(profile);
}

function formatProfile(p: MemberProfile): string {
  const interests = JSON.parse(p.interests) as string[];
  const groups = JSON.parse(p.groups_active) as string[];
  const groupNames = groups.map((jid) => getGroupName(jid));

  const lines = ['📋 *Your Profile*', ''];

  if (p.name) lines.push(`*Name:* ${p.name}`);
  if (p.opted_in && interests.length > 0) {
    lines.push(`*Interests:* ${interests.join(', ')}`);
  }
  if (groupNames.length > 0) {
    lines.push(`*Active in:* ${groupNames.join(', ')}`);
  }
  if (p.event_count > 0) {
    lines.push(`*Events attended:* ${p.event_count}`);
  }

  const firstSeen = new Date(p.first_seen * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  lines.push(`*Member since:* ${firstSeen}`);

  if (!p.opted_in) {
    lines.push('');
    lines.push('_Set interests to opt in: `!profile interests hiking, cooking`_');
  }

  lines.push('');
  lines.push('_Use `!profile delete` to remove your data._');

  return lines.join('\n');
}
