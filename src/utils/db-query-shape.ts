import type { MemoryEntry, WhatsAppSafetyMetrics, WhatsAppSafetyState } from './db-types.js';

export type DbNumeric = string | number;

export function toNumber(value: DbNumeric | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string');
      }
      return [];
    } catch {
      return [];
    }
  }

  return [];
}

export function toJsonArrayString(value: unknown): string {
  return JSON.stringify(parseJsonArray(value));
}

export function appendUniqueJsonArrayItem(existing: unknown, item: string): string {
  const items = parseJsonArray(existing);
  if (!items.includes(item)) items.push(item);
  return JSON.stringify(items);
}

export function toBareJid(senderJid: string): string {
  return senderJid.split('@')[0].split(':')[0];
}

export function extractSearchTerms(query: string, limit: number = 5): string[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .slice(0, limit);

  return Array.from(new Set(terms));
}

export function formatMemoriesForPromptEntries(memories: MemoryEntry[]): string {
  if (memories.length === 0) return '';

  const byCategory = new Map<string, string[]>();
  for (const memory of memories) {
    const list = byCategory.get(memory.category) ?? [];
    list.push(memory.fact);
    byCategory.set(memory.category, list);
  }

  const lines = ['Community knowledge (facts you know about this group):'];
  for (const [category, facts] of byCategory) {
    lines.push(`  ${category}:`);
    for (const fact of facts) {
      lines.push(`    - ${fact}`);
    }
  }

  return lines.join('\n');
}

export interface WhatsAppMetricCountsLike {
  pending?: DbNumeric | null;
  held?: DbNumeric | null;
  sentLastHour?: DbNumeric | null;
  sentLastDay?: DbNumeric | null;
  failedLastHour?: DbNumeric | null;
  sent_last_hour?: DbNumeric | null;
  sent_last_day?: DbNumeric | null;
  failed_last_hour?: DbNumeric | null;
}

export function mapWhatsAppSafetyMetrics(
  counts: WhatsAppMetricCountsLike | undefined,
  state: WhatsAppSafetyState,
): WhatsAppSafetyMetrics {
  return {
    pending: toNumber(counts?.pending),
    held: toNumber(counts?.held),
    sentLastHour: toNumber(counts?.sentLastHour ?? counts?.sent_last_hour),
    sentLastDay: toNumber(counts?.sentLastDay ?? counts?.sent_last_day),
    failedLastHour: toNumber(counts?.failedLastHour ?? counts?.failed_last_hour),
    paused: state.paused,
    risk: state.risk,
    score: state.score,
  };
}
