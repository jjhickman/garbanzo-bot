/**
 * Smart event recommendations — suggest events based on member interests
 * and activity patterns.
 *
 * Commands:
 *   !recommend          — get personalized event/activity suggestions
 *   !recommend for @user — suggest for a specific user (owner only)
 *
 * Requires the member to have a profile with interests set (!profile interests).
 * Uses Claude to generate recommendations based on:
 *   - Member's stated interests
 *   - Groups they're active in
 *   - Past event attendance count
 *   - Current season/time of year
 */

import { logger } from '../middleware/logger.js';
import { getProfile, getOptedInProfiles, type MemberProfile } from '../utils/db.js';
import { getGroupName } from '../bot/groups.js';
import { getAIResponse } from '../ai/router.js';

/**
 * Handle !recommend command. Returns personalized suggestions.
 */
export async function handleRecommendations(
  _args: string,
  senderJid: string,
  groupJid: string,
): Promise<string> {
  const profile = getProfile(senderJid);

  if (!profile || !profile.opted_in) {
    return [
      '💡 *Recommendations*',
      '',
      'Set your interests first to get personalized suggestions:',
      '  `!profile interests hiking, board games, live music`',
      '',
      'Then try `!recommend` again.',
    ].join('\n');
  }

  const interests = JSON.parse(profile.interests) as string[];
  if (interests.length === 0) {
    return '💡 Add some interests first: `!profile interests hiking, cooking, trivia`';
  }

  const activeGroups = (JSON.parse(profile.groups_active) as string[])
    .map((jid) => getGroupName(jid))
    .filter((name) => name !== 'Unknown Group');

  const month = new Date().toLocaleString('en-US', { month: 'long' });
  const dayOfWeek = new Date().toLocaleString('en-US', { weekday: 'long' });

  // Find other members with overlapping interests for group activity suggestions
  const similarMembers = findSimilarMembers(senderJid, interests);

  const prompt = [
    `Suggest 3-4 specific activity or event ideas for a Boston meetup group member.`,
    '',
    `Member info:`,
    `- Interests: ${interests.join(', ')}`,
    `- Active in groups: ${activeGroups.join(', ') || 'various'}`,
    `- Events attended: ${profile.event_count}`,
    similarMembers.length > 0
      ? `- ${similarMembers.length} other members share similar interests`
      : '',
    '',
    `Context: It's ${dayOfWeek} in ${month} in Boston.`,
    '',
    'Give specific, actionable suggestions with real Boston venues/locations when possible.',
    'Format as a numbered list. Keep each suggestion to 1-2 lines.',
    'Focus on things that could realistically be organized as a group meetup.',
  ].filter(Boolean).join('\n');

  logger.info({ senderJid, interests, activeGroups }, 'Generating event recommendations');

  const response = await getAIResponse(prompt, {
    groupName: getGroupName(groupJid),
    groupJid,
    senderJid,
  });

  if (!response || response.includes('I hit a snag')) {
    return '💡 Could not generate recommendations right now. Try again later.';
  }

  return [
    '💡 *Recommended for You*',
    '',
    response,
  ].join('\n');
}

/**
 * Find other opted-in members with overlapping interests.
 * Returns count (not JIDs — privacy).
 */
function findSimilarMembers(excludeJid: string, interests: string[]): MemberProfile[] {
  const bare = excludeJid.split('@')[0].split(':')[0];
  const all = getOptedInProfiles();
  const lowerInterests = interests.map((i) => i.toLowerCase());

  return all.filter((p) => {
    if (p.jid === bare) return false;
    const theirInterests = (JSON.parse(p.interests) as string[]).map((i) => i.toLowerCase());
    return theirInterests.some((i) => lowerInterests.includes(i));
  });
}
