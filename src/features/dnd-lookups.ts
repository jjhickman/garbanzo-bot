/**
 * D&D 5e SRD API lookups — spell, monster, class, and equipment searches
 * via dnd5eapi.co (free, no API key, 10K req/s).
 *
 * Extracted from dnd.ts for maintainability.
 */

import { logger } from '../middleware/logger.js';
import { bold } from '../utils/formatting.js';

const API_BASE = 'https://www.dnd5eapi.co/api/2014';
const TIMEOUT_MS = 8_000;

// ── SRD API helpers ─────────────────────────────────────────────────

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

export async function lookupSpell(query: string): Promise<string> {
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

export async function lookupMonster(query: string): Promise<string> {
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

export async function lookupClass(query: string): Promise<string> {
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

export async function lookupItem(query: string): Promise<string> {
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
