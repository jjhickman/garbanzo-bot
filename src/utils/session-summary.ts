import type { DbMessage } from './db-types.js';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'have', 'what', 'when', 'where', 'which', 'about',
  'your', 'you', 'just', 'into', 'will', 'would', 'there', 'their', 'them', 'they', 'been', 'were', 'are',
  'was', 'has', 'had', 'not', 'but', 'can', 'all', 'any', 'its', 'our', 'out', 'who', 'how', 'why', 'let',
  'lets', 'should', 'could', 'did', 'does', 'doing', 'we', 'i', 'im', 'a', 'an', 'to', 'of', 'in', 'on',
]);

function scoreMessage(text: string): number {
  let score = 0;

  if (text.includes('?')) score += 3;
  if (/https?:\/\//.test(text)) score += 2;
  if (/\b(today|tonight|tomorrow|next\s+(week|month|friday|saturday|sunday)|at\s+\d|pm|am)\b/i.test(text)) {
    score += 3;
  }
  if (/\b(let'?s|sounds good|i'?m in|count me|confirmed|plan is|decided|ship it)\b/i.test(text)) {
    score += 2;
  }
  if (text.length > 100) score += 1;
  if (text.length > 200) score += 1;
  if (text.length < 15) score -= 2;

  return score;
}

function topTopics(messages: DbMessage[], limit: number = 4): string[] {
  const counts = new Map<string, number>();

  for (const message of messages) {
    const tokens = message.text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
    for (const token of tokens) {
      if (token.length < 3 || STOPWORDS.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([token]) => token);
}

function trimLine(text: string, maxChars: number = 90): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

export function summarizeSession(messages: DbMessage[], participants: string[]): {
  summaryText: string;
  topicTags: string[];
} {
  if (messages.length === 0) {
    return {
      summaryText: '',
      topicTags: [],
    };
  }

  const scored = messages
    .map((message) => ({ message, score: scoreMessage(message.text) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .sort((a, b) => a.message.timestamp - b.message.timestamp)
    .map((entry) => `${entry.message.sender}: ${trimLine(entry.message.text)}`);

  const topParticipantList = participants.slice(0, 6).join(', ');
  const extraParticipants = participants.length > 6 ? ` +${participants.length - 6} more` : '';
  const topics = topTopics(messages);

  const lines = [
    `Participants: ${topParticipantList}${extraParticipants}.`,
    topics.length > 0 ? `Topics: ${topics.join(', ')}.` : '',
    ...scored,
  ].filter(Boolean);

  let summaryText = lines.join(' | ');
  if (summaryText.length > 900) {
    summaryText = `${summaryText.slice(0, 897)}...`;
  }

  return {
    summaryText,
    topicTags: topics,
  };
}

/**
 * Build a contextualized embedding input by prepending structured metadata
 * to the summary text. This enriches the vector representation so semantic
 * search can match on group identity, time context, participants, and topics
 * — not just the raw conversational content.
 */
export function buildContextualizedEmbeddingInput(
  summaryText: string,
  options: {
    chatJid?: string;
    startedAt?: number;
    endedAt?: number;
    participants?: string[];
    topicTags?: string[];
  } = {},
): string {
  const parts: string[] = [];

  if (options.chatJid) {
    parts.push(`group: ${options.chatJid}`);
  }

  if (options.startedAt && options.endedAt) {
    const startIso = new Date(options.startedAt * 1000).toISOString().slice(0, 16);
    const endIso = new Date(options.endedAt * 1000).toISOString().slice(0, 16);
    parts.push(`time: ${startIso} to ${endIso}`);
  }

  if (options.participants && options.participants.length > 0) {
    parts.push(`participants: ${options.participants.slice(0, 8).join(', ')}`);
  }

  if (options.topicTags && options.topicTags.length > 0) {
    parts.push(`topics: ${options.topicTags.join(', ')}`);
  }

  if (parts.length === 0) return summaryText;

  return `${parts.join(' | ')}\n${summaryText}`;
}

export function scoreSessionMatch(summaryText: string, topicTags: string[], query: string, endedAt: number): number {
  const lowerSummary = summaryText.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const queryTokens = Array.from(new Set((lowerQuery.match(/[a-z0-9']+/g) ?? []).filter((token) => token.length >= 3)));

  let tokenHits = 0;
  for (const token of queryTokens) {
    if (lowerSummary.includes(token) || topicTags.includes(token)) tokenHits += 1;
  }

  const now = Math.floor(Date.now() / 1000);
  const ageHours = Math.max(0, (now - endedAt) / 3600);
  const recencyBoost = 1 / (1 + ageHours / 48);

  return (tokenHits * 3) + recencyBoost;
}
