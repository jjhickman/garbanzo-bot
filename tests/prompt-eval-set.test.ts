import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const evalSetPath = resolve(dirname(fileURLToPath(import.meta.url)), 'evals', 'prompt-eval-set.json');

/** Must match the tool names registered in src/ai/tools.ts. */
const VALID_TOOLS = [
  'get_weather',
  'get_transit_status',
  'find_venues',
  'get_news',
  'lookup_book',
  'web_search',
  'search_community_memory',
  'list_band_songs',
  'find_band_song',
  'next_rehearsal',
  'current_setlist',
] as const;

const CATEGORIES = [
  'tool_routing',
  'refusal',
  'injection',
  'persona_voice',
  'identity',
  'moderation',
  'edge_case',
] as const;

const evalCaseSchema = z.object({
  id: z.string().regex(/^[a-z]+-[a-z]+-\d{2}$/),
  category: z.enum(CATEGORIES),
  group: z.string().min(1),
  message: z.string().min(1),
  quoted: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
  expected: z.object({
    tool: z.enum(VALID_TOOLS).nullable().optional(),
    behavior: z.string().min(10),
    must: z.array(z.string().min(1)).optional(),
    mustNot: z.array(z.string().min(1)).optional(),
  }),
});

const evalSetSchema = z.object({
  $comment: z.string(),
  version: z.number().int().positive(),
  cases: z.array(evalCaseSchema).min(30),
});

describe('prompt eval set', () => {
  const raw = JSON.parse(readFileSync(evalSetPath, 'utf-8')) as unknown;

  it('matches the eval case schema', () => {
    const result = evalSetSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(`prompt-eval-set.json invalid: ${result.error.message}`);
    }
  });

  it('has unique case ids', () => {
    const parsed = evalSetSchema.parse(raw);
    const ids = parsed.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every category with at least 3 cases', () => {
    const parsed = evalSetSchema.parse(raw);
    for (const category of CATEGORIES) {
      const count = parsed.cases.filter((c) => c.category === category).length;
      expect(count, `category ${category}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('every expectation names a behavior and at least one checkable criterion', () => {
    const parsed = evalSetSchema.parse(raw);
    for (const c of parsed.cases) {
      const hasCriterion =
        (c.expected.must?.length ?? 0) > 0 ||
        (c.expected.mustNot?.length ?? 0) > 0 ||
        c.expected.tool !== undefined;
      expect(hasCriterion, `case ${c.id} needs must/mustNot/tool`).toBe(true);
    }
  });
});
