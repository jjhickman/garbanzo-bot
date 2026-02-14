/**
 * D&D 5e feature — dice rolling + SRD content lookups.
 *
 * Dice rolling: local implementation, supports standard notation (2d6+3, d20, 4d8-1, etc.)
 * SRD lookups: dnd5eapi.co (free, no API key, 10K req/s)
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

const API_BASE = 'https://www.dnd5eapi.co/api/2014';
const TIMEOUT_MS = 8_000;

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

// ── SRD API lookups ─────────────────────────────────────────────────

async function fetchSRD(path: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch (err) {
    logger.error({ err, path }, 'D&D API fetch failed');
    return null;
  }
}

/** Search an endpoint by name, returning the slug for the best match */
async function searchSRD(endpoint: string, query: string): Promise<string | null> {
  const data = await fetchSRD(`/${endpoint}?name=${encodeURIComponent(query)}`);
  if (!data) return null;

  const results = data.results as Array<{ index: string; name: string }> | undefined;
  if (!results || results.length === 0) return null;

  // Exact match first, then first result
  const exact = results.find((r) => r.name.toLowerCase() === query.toLowerCase());
  return exact?.index ?? results[0].index;
}

// ── Spell lookup ────────────────────────────────────────────────────

async function lookupSpell(query: string): Promise<string> {
  const slug = await searchSRD('spells', query);
  if (!slug) return `🧙 No spell found matching "${query}".`;

  const spell = await fetchSRD(`/spells/${slug}`);
  if (!spell) return `🧙 Failed to fetch spell details.`;

  const lines: string[] = [
    `🧙 ${bold(spell.name as string)}`,
    `_${(spell.level as number) === 0 ? 'Cantrip' : `Level ${spell.level}`} ${spell.school ? (spell.school as { name: string }).name : ''}_`,
    '',
  ];

  if (spell.casting_time) lines.push(`${bold('Casting Time')}: ${spell.casting_time}`);
  if (spell.range) lines.push(`${bold('Range')}: ${spell.range}`);
  if (spell.duration) lines.push(`${bold('Duration')}: ${spell.duration}`);
  if (spell.concentration) lines.push(`${bold('Concentration')}: Yes`);

  const components = spell.components as string[] | undefined;
  if (components) {
    let compStr = components.join(', ');
    if (spell.material) compStr += ` (${spell.material})`;
    lines.push(`${bold('Components')}: ${compStr}`);
  }

  lines.push('');

  const desc = spell.desc as string[] | undefined;
  if (desc) lines.push(desc.join('\n\n').slice(0, 1500));

  const higherLevel = spell.higher_level as string[] | undefined;
  if (higherLevel?.length) {
    lines.push('');
    lines.push(`${bold('At Higher Levels')}: ${higherLevel.join(' ').slice(0, 500)}`);
  }

  return lines.join('\n');
}

// ── Monster lookup ──────────────────────────────────────────────────

async function lookupMonster(query: string): Promise<string> {
  const slug = await searchSRD('monsters', query);
  if (!slug) return `👹 No monster found matching "${query}".`;

  const mon = await fetchSRD(`/monsters/${slug}`);
  if (!mon) return `👹 Failed to fetch monster details.`;

  const lines: string[] = [
    `👹 ${bold(mon.name as string)}`,
    `_${mon.size} ${mon.type}${mon.subtype ? ` (${mon.subtype})` : ''}, ${mon.alignment}_`,
    '',
    `${bold('AC')}: ${mon.armor_class ? (mon.armor_class as Array<{ value: number }>)[0]?.value : '?'} | ${bold('HP')}: ${mon.hit_points} (${mon.hit_points_roll ?? mon.hit_dice}) | ${bold('Speed')}: ${formatSpeed(mon.speed as Record<string, string> | undefined)}`,
    '',
    `*STR* ${mon.strength} | *DEX* ${mon.dexterity} | *CON* ${mon.constitution} | *INT* ${mon.intelligence} | *WIS* ${mon.wisdom} | *CHA* ${mon.charisma}`,
    '',
    `${bold('CR')}: ${mon.challenge_rating} (${(mon.xp ?? 0).toLocaleString()} XP)`,
  ];

  const senses = mon.senses as Record<string, string> | undefined;
  if (senses) {
    const senseParts = Object.entries(senses).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
    if (senseParts.length) lines.push(`${bold('Senses')}: ${senseParts.join(', ')}`);
  }

  const languages = mon.languages as string | undefined;
  if (languages) lines.push(`${bold('Languages')}: ${languages || 'None'}`);

  // Special abilities
  const abilities = mon.special_abilities as Array<{ name: string; desc: string }> | undefined;
  if (abilities?.length) {
    lines.push('');
    lines.push(bold('Special Abilities:'));
    for (const a of abilities.slice(0, 5)) {
      lines.push(`• ${bold(a.name)}: ${a.desc.slice(0, 300)}`);
    }
  }

  // Actions
  const actions = mon.actions as Array<{ name: string; desc: string }> | undefined;
  if (actions?.length) {
    lines.push('');
    lines.push(bold('Actions:'));
    for (const a of actions.slice(0, 5)) {
      lines.push(`• ${bold(a.name)}: ${a.desc.slice(0, 300)}`);
    }
  }

  return lines.join('\n');
}

function formatSpeed(speed: Record<string, string> | undefined): string {
  if (!speed) return '?';
  return Object.entries(speed).map(([k, v]) => k === 'walk' ? v : `${k} ${v}`).join(', ');
}

// ── Class lookup ────────────────────────────────────────────────────

async function lookupClass(query: string): Promise<string> {
  const slug = await searchSRD('classes', query);
  if (!slug) return `⚔️ No class found matching "${query}".`;

  const cls = await fetchSRD(`/classes/${slug}`);
  if (!cls) return `⚔️ Failed to fetch class details.`;

  const lines: string[] = [
    `⚔️ ${bold(cls.name as string)}`,
    '',
    `${bold('Hit Die')}: d${cls.hit_die}`,
  ];

  const profs = cls.proficiencies as Array<{ name: string }> | undefined;
  if (profs?.length) {
    lines.push(`${bold('Proficiencies')}: ${profs.map((p) => p.name).join(', ')}`);
  }

  const saves = cls.saving_throws as Array<{ name: string }> | undefined;
  if (saves?.length) {
    lines.push(`${bold('Saving Throws')}: ${saves.map((s) => s.name).join(', ')}`);
  }

  const subclasses = cls.subclasses as Array<{ name: string }> | undefined;
  if (subclasses?.length) {
    lines.push(`${bold('Subclasses')}: ${subclasses.map((s) => s.name).join(', ')}`);
  }

  return lines.join('\n');
}

// ── Equipment lookup ────────────────────────────────────────────────

async function lookupItem(query: string): Promise<string> {
  // Try equipment first, then magic items
  let slug = await searchSRD('equipment', query);
  let isMagic = false;

  if (!slug) {
    slug = await searchSRD('magic-items', query);
    isMagic = true;
  }

  if (!slug) return `🗡️ No item found matching "${query}".`;

  const item = await fetchSRD(`/${isMagic ? 'magic-items' : 'equipment'}/${slug}`);
  if (!item) return `🗡️ Failed to fetch item details.`;

  const lines: string[] = [
    `🗡️ ${bold(item.name as string)}`,
  ];

  if (isMagic) {
    const rarity = item.rarity as { name: string } | undefined;
    if (rarity) lines.push(`_${rarity.name}_`);

    const desc = item.desc as string[] | undefined;
    if (desc) {
      lines.push('');
      lines.push(desc.join('\n\n').slice(0, 1500));
    }
  } else {
    const cat = item.equipment_category as { name: string } | undefined;
    if (cat) lines.push(`_${cat.name}_`);

    const cost = item.cost as { quantity: number; unit: string } | undefined;
    if (cost) lines.push(`${bold('Cost')}: ${cost.quantity} ${cost.unit}`);

    const weight = item.weight as number | undefined;
    if (weight) lines.push(`${bold('Weight')}: ${weight} lb`);

    const damage = item.damage as { damage_dice: string; damage_type: { name: string } } | undefined;
    if (damage) lines.push(`${bold('Damage')}: ${damage.damage_dice} ${damage.damage_type.name}`);

    const desc = item.desc as string[] | undefined;
    if (desc?.length) {
      lines.push('');
      lines.push(desc.join('\n\n').slice(0, 1000));
    }
  }

  return lines.join('\n');
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
