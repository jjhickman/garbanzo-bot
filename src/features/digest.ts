/**
 * Daily digest — sends a summary of group activity to the owner's DM at 9 PM.
 *
 * Uses stats from the middleware/stats tracker. Scheduled via setTimeout
 * (no cron dependency). Reschedules itself after each run.
 */

import { logger } from '../middleware/logger.js';
import { getCurrentStats, type DailyStats } from '../middleware/stats.js';
import { getGroupName } from '../core/groups-config.js';
import { getDailyGroupActivity, saveDailyStats } from '../utils/db.js';

export async function archiveDailyDigest(stats: DailyStats): Promise<void> {
  try {
    const archiveData = serializeStats(stats);
    await saveDailyStats(stats.date, archiveData);
  } catch (err) {
    logger.error({ err, date: stats.date }, 'Failed to archive daily stats');
  }
}

/**
 * Generate a digest for the current (partial) day without resetting.
 * Used by `!digest` command to preview stats so far.
 */
export async function previewDigest(): Promise<string> {
  return await formatDigest(getCurrentStats());
}

export async function formatDigest(stats: DailyStats): Promise<string> {
  const lines: string[] = [
    `🫘 *Daily Digest — ${stats.date}*`,
    '',
  ];

  let totalMessages = 0;
  let totalUsers = 0;
  let totalBotResponses = 0;
  let totalOllama = 0;
  let totalClaude = 0;
  let totalOpenAI = 0;
  let totalGemini = 0;
  let totalBedrock = 0;
  let totalFlags = 0;

  // Sort groups by message count (most active first)
  const sorted = [...stats.groups.entries()].sort(
    (a, b) => b[1].messageCount - a[1].messageCount,
  );

  let groupCount = sorted.length;

  if (sorted.length === 0) {
    const fallback = await getDailyGroupActivity(stats.date);
    if (fallback.length === 0) {
      lines.push('_No group activity recorded today._');
    } else {
      groupCount = fallback.length;
      lines.push('*Group Activity:*');
      for (const row of fallback) {
        const name = getGroupName(row.chatJid);
        lines.push(`• *${name}* — ${row.messageCount} msgs, ${row.activeUsers} active users`);
        totalMessages += row.messageCount;
        totalUsers += row.activeUsers;
      }
      lines.push('');
      lines.push('_Recovered from persisted message logs after runtime reset; bot response route splits may be lower than actual._');
    }
  } else {
    lines.push('*Group Activity:*');
    for (const [jid, g] of sorted) {
      const name = getGroupName(jid);
      const userCount = g.activeUsers.size;
      lines.push(`• *${name}* — ${g.messageCount} msgs, ${userCount} active users`);
      if (g.botResponses > 0) {
        lines.push(
          `  ↳ ${g.botResponses} bot responses (${g.ollamaRouted} Ollama, ${g.claudeRouted} Claude, ${g.openaiRouted} OpenAI, ${g.geminiRouted} Gemini, ${g.bedrockRouted} Bedrock)`,
        );
      }
      if (g.moderationFlags > 0) {
        lines.push(`  ⚠️ ${g.moderationFlags} moderation flags`);
      }
      totalMessages += g.messageCount;
      totalUsers += userCount;
      totalBotResponses += g.botResponses;
      totalOllama += g.ollamaRouted;
      totalClaude += g.claudeRouted;
      totalOpenAI += g.openaiRouted;
      totalGemini += g.geminiRouted;
      totalBedrock += g.bedrockRouted;
      totalFlags += g.moderationFlags;
    }
  }

  lines.push('');
  lines.push('*Totals:*');
  lines.push(`• ${totalMessages} messages across ${groupCount} groups`);
  lines.push(`• ${totalUsers} unique active users`);

  if (totalBotResponses > 0) {
    const totalCloud = totalClaude + totalOpenAI + totalGemini + totalBedrock;
    const ollamaPct = Math.round((totalOllama / totalBotResponses) * 100);
    const cloudPct = Math.max(0, 100 - ollamaPct);
    const openAiShare = totalCloud > 0 ? Math.round((totalOpenAI / totalCloud) * 100) : 0;
    const geminiShare = totalCloud > 0 ? Math.round((totalGemini / totalCloud) * 100) : 0;
    const bedrockShare = totalCloud > 0 ? Math.round((totalBedrock / totalCloud) * 100) : 0;
    lines.push(`• ${totalBotResponses} bot responses (${ollamaPct}% Ollama, ${cloudPct}% cloud)`);
    if (totalCloud > 0) {
      const claudeShare = Math.max(0, 100 - openAiShare - geminiShare - bedrockShare);
      lines.push(`  ↳ cloud split: ${claudeShare}% Claude, ${openAiShare}% OpenAI, ${geminiShare}% Gemini, ${bedrockShare}% Bedrock`);
    }
  }

  if (totalFlags > 0) {
    lines.push(`• ⚠️ ${totalFlags} moderation flags`);
  }

  if (stats.ownerDMs > 0) {
    lines.push(`• ${stats.ownerDMs} owner DM interactions`);
  }

  return lines.join('\n');
}

/** Serialize DailyStats to JSON (convert Sets to arrays) */
function serializeStats(stats: DailyStats): string {
  const groups: Record<string, object> = {};
  for (const [jid, g] of stats.groups) {
    groups[jid] = {
      messageCount: g.messageCount,
      activeUsers: [...g.activeUsers],
      botResponses: g.botResponses,
      ollamaRouted: g.ollamaRouted,
      claudeRouted: g.claudeRouted,
      openaiRouted: g.openaiRouted,
      geminiRouted: g.geminiRouted,
      bedrockRouted: g.bedrockRouted,
      moderationFlags: g.moderationFlags,
    };
  }
  return JSON.stringify({ date: stats.date, groups, ownerDMs: stats.ownerDMs });
}

