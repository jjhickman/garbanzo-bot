/**
 * D&D 5e feature — dice rolling + SRD content lookups.
 *
 * Dice rolling: local implementation, supports standard notation (2d6+3, d20, 4d8-1, etc.)
 * SRD lookups: dnd5eapi.co (free, no API key, 10K req/s) — logic in dnd-lookups.ts
 *
 * Commands:
 *   !roll 2d6+3       — roll dice
 *   !roll d20          — single d20
 *   !spell fireball    — spell lookup
 *   !monster goblin    — monster stat block
 *   !class wizard      — class info
 *   !item longsword    — equipment lookup
 */

import { logger } from '../middleware/logger.js';
import { bold } from '../utils/formatting.js';
import { lookupSpell, lookupMonster, lookupClass, lookupItem } from './dnd-lookups.js';

// ── Dice roller ─────────────────────────────────────────────────────

export interface RollResult {
  notation: string;
  rolls: number[];
  modifier: number;
  total: number;
}

/**
 * Parse and roll standard dice notation.
 * Supports: d20, 2d6, 4d8+3, 2d10-1, d100
 */
export function rollDice(notation: string): RollResult | null {
  const match = notation.trim().match(/^(\d*)d(\d+)([+-]\d+)?$/i);
  if (!match) return null;

  const count = Number(match[1] || 1);
  const sides = Number(match[2]);
  const modifier = Number(match[3] || 0);

  if (count < 1 || count > 100 || sides < 2 || sides > 1000) return null;

  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    rolls.push(Math.floor(Math.random() * sides) + 1);
  }

  const total = rolls.reduce((a, b) => a + b, 0) + modifier;

  return { notation: notation.trim(), rolls, modifier, total };
}

export function formatRoll(result: RollResult): string {
  const modStr = result.modifier > 0
    ? ` + ${result.modifier}`
    : result.modifier < 0
      ? ` - ${Math.abs(result.modifier)}`
      : '';

  if (result.rolls.length === 1) {
    return `🎲 ${bold(result.notation)}: *${result.total}*${modStr ? ` (${result.rolls[0]}${modStr})` : ''}`;
  }

  const rollsStr = result.rolls.join(', ');
  return `🎲 ${bold(result.notation)}: *${result.total}*\n  ↳ [${rollsStr}]${modStr}`;
}

// ── Public handler ──────────────────────────────────────────────────

/**
 * Handle D&D commands. Expects the query AFTER the command prefix.
 *
 * Routing:
 * - "2d6+3", "d20" → dice roll
 * - "spell fireball" → spell lookup
 * - "monster goblin" → monster lookup
 * - "class wizard" → class lookup
 * - "item longsword" → equipment lookup
 * - Just a query with no prefix → try spell first, then monster, then item
 */
export async function handleDnd(query: string): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) return getDndHelp();

  // Dice roll — check if it matches dice notation
  const diceMatch = trimmed.match(/^(\d*d\d+(?:[+-]\d+)?(?:\s+\d*d\d+(?:[+-]\d+)?)*)$/i);
  if (diceMatch) {
    const parts = trimmed.split(/\s+/);
    const results = parts.map(rollDice).filter((r): r is RollResult => r !== null);
    if (results.length === 0) return '🎲 Invalid dice notation. Try: d20, 2d6+3, 4d8-1';
    return results.map(formatRoll).join('\n');
  }

  // Subcommand routing
  const lower = trimmed.toLowerCase();

  if (lower.startsWith('spell ') || lower.startsWith('s ')) {
    return await lookupSpell(trimmed.replace(/^(spell|s)\s+/i, ''));
  }
  if (lower.startsWith('monster ') || lower.startsWith('mon ') || lower.startsWith('m ')) {
    return await lookupMonster(trimmed.replace(/^(monster|mon|m)\s+/i, ''));
  }
  if (lower.startsWith('class ') || lower.startsWith('c ')) {
    return await lookupClass(trimmed.replace(/^(class|c)\s+/i, ''));
  }
  if (lower.startsWith('item ') || lower.startsWith('i ') || lower.startsWith('equip ')) {
    return await lookupItem(trimmed.replace(/^(item|i|equip)\s+/i, ''));
  }

  // Roll shorthand — if it looks like dice notation anywhere
  const rollMatch = trimmed.match(/(\d*d\d+(?:[+-]\d+)?)/i);
  if (rollMatch) {
    const result = rollDice(rollMatch[1]);
    if (result) return formatRoll(result);
  }

  // Fuzzy — try spell, then monster, then item
  logger.debug({ query: trimmed }, 'D&D fuzzy search');
  const spellResult = await lookupSpell(trimmed);
  if (!spellResult.includes('No spell found')) return spellResult;

  const monsterResult = await lookupMonster(trimmed);
  if (!monsterResult.includes('No monster found')) return monsterResult;

  const itemResult = await lookupItem(trimmed);
  if (!itemResult.includes('No item found')) return itemResult;

  return `🎲 Nothing found for "${trimmed}". Try:\n• !roll d20\n• !dnd spell fireball\n• !dnd monster goblin\n• !dnd class wizard\n• !dnd item longsword`;
}

function getDndHelp(): string {
  return [
    `🎲 ${bold('D&D 5e Commands')}`,
    '',
    `${bold('Dice Rolling')}:`,
    '  !roll d20 — single d20',
    '  !roll 2d6+3 — two d6, add 3',
    '  !roll 4d8 d20 — multiple rolls',
    '',
    `${bold('SRD Lookups')}:`,
    '  !dnd spell fireball',
    '  !dnd monster goblin',
    '  !dnd class wizard',
    '  !dnd item longsword',
    '',
    '_Searches the official D&D 5e SRD._',
  ].join('\n');
}
