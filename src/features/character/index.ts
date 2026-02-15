/**
 * Character assembly, argument parsing, formatting, and public handler.
 * Re-exports the full public API of the character module.
 */

import { logger } from '../../middleware/logger.js';
import {
  SRD_RACES, SRD_CLASSES, BACKGROUNDS, ALIGNMENTS,
  pickRandom, pickRandomN,
  CLASS_SAVE_PROFICIENCIES, CLASS_SKILL_OPTIONS, ALL_SKILLS,
  CLASS_EQUIPMENT, CLASS_WEAPONS, FIRST_NAMES,
  PERSONALITY_TRAITS, IDEALS, BONDS, FLAWS,
} from './srd-data.js';
import {
  generateAbilityScores, applyRacialBonuses,
  abilityModifier, formatModifier,
} from './abilities.js';
import {
  RACE_SPEED, RACE_NAMES, CLASS_NAMES, CLASS_HIT_DIE,
  RACE_TRAITS, RACE_LANGUAGES, CLASS_FEATURES,
  calculateAC, generateAppearance, generateBackstory,
  generateStartingTreasure, BACKGROUND_ALLIES,
} from './class-race-data.js';
import type { CharacterData } from './class-race-data.js';
import { generateSpellcasting, profBonusForLevel, calculateHP } from './spellcasting.js';
import { generateCharacterPDF } from './pdf.js';

// ── Re-exports (preserve public API) ────────────────────────────────

export type { AbilityName } from './srd-data.js';
export { pickRandom, pickRandomN } from './srd-data.js';
export type { AbilityScores } from './abilities.js';
export {
  roll4d6DropLowest, abilityModifier, formatModifier,
  generateAbilityScores, applyRacialBonuses,
} from './abilities.js';
export type { CharacterData } from './class-race-data.js';
export { generateCharacterPDF } from './pdf.js';

// ── Proficiency Helpers ──────────────────────────────────────────────

const ARMOR_PROFICIENCIES: Record<string, string> = {
  barbarian: 'Light, Medium, Shields', bard: 'Light', cleric: 'Light, Medium, Shields',
  druid: 'Light, Medium, Shields (nonmetal)', fighter: 'All armor, Shields', monk: 'None',
  paladin: 'All armor, Shields', ranger: 'Light, Medium, Shields', rogue: 'Light',
  sorcerer: 'None', warlock: 'Light', wizard: 'None',
};

const WEAPON_PROFICIENCIES: Record<string, string> = {
  barbarian: 'Simple, Martial', bard: 'Simple, Hand Crossbow, Longsword, Rapier, Shortsword',
  cleric: 'Simple', druid: 'Club, Dagger, Dart, Javelin, Mace, Quarterstaff, Scimitar, Sickle, Sling, Spear',
  fighter: 'Simple, Martial', monk: 'Simple, Shortsword', paladin: 'Simple, Martial',
  ranger: 'Simple, Martial', rogue: 'Simple, Hand Crossbow, Longsword, Rapier, Shortsword',
  sorcerer: 'Dagger, Dart, Sling, Quarterstaff, Lt. Crossbow', warlock: 'Simple',
  wizard: 'Dagger, Dart, Sling, Quarterstaff, Lt. Crossbow',
};

function getArmorProficiencies(classIndex: string): string {
  return ARMOR_PROFICIENCIES[classIndex] ?? 'None';
}

function getWeaponProficiencies(classIndex: string): string {
  return WEAPON_PROFICIENCIES[classIndex] ?? 'Simple';
}

// ── Character Assembly ──────────────────────────────────────────────

/** Generate a complete character */
export function generateCharacter(args?: CharacterArgs): CharacterData {
  const raceIndex = args?.race;
  const classIndex = args?.class;
  const description = args?.description;

  const race = raceIndex && SRD_RACES.includes(raceIndex as typeof SRD_RACES[number])
    ? raceIndex
    : pickRandom(SRD_RACES);
  const cls = classIndex && SRD_CLASSES.includes(classIndex as typeof SRD_CLASSES[number])
    ? classIndex
    : pickRandom(SRD_CLASSES);
  const level = args?.level ?? 1;
  const profBonus = profBonusForLevel(level);

  const baseScores = generateAbilityScores(cls);
  const abilities = applyRacialBonuses(baseScores, race);

  const hitDie = CLASS_HIT_DIE[cls] ?? 8;
  const conMod = abilityModifier(abilities.con);
  const hp = calculateHP(hitDie, conMod, level);

  const background = args?.background
    && BACKGROUNDS.includes(args.background as typeof BACKGROUNDS[number])
    ? args.background as typeof BACKGROUNDS[number]
    : pickRandom(BACKGROUNDS);
  const alignment = args?.alignment ?? pickRandom(ALIGNMENTS);

  const saveProficiencies = CLASS_SAVE_PROFICIENCIES[cls] ?? ['str', 'con'];
  const skillOptions = CLASS_SKILL_OPTIONS[cls] ?? { choose: 2, from: ALL_SKILLS };
  const skillProficiencies = pickRandomN(skillOptions.from, skillOptions.choose);

  const name = args?.name ?? pickRandom(FIRST_NAMES[race] ?? FIRST_NAMES.human);
  const weapons = CLASS_WEAPONS[cls] ?? [];
  const equipment = CLASS_EQUIPMENT[cls] ?? '';

  const racialTraits = RACE_TRAITS[race] ?? '';
  const classFeats = CLASS_FEATURES[cls] ?? '';

  const languages = RACE_LANGUAGES[race] ?? 'Common';
  const proficienciesAndLanguages = `Languages: ${languages}\n\nArmor: ${getArmorProficiencies(cls)}\nWeapons: ${getWeaponProficiencies(cls)}`;

  // Appearance generation
  const appearance = generateAppearance(race);
  const baseBackstory = generateBackstory(background, RACE_NAMES[race] ?? race, CLASS_NAMES[cls] ?? cls);
  const backstory = description
    ? `${baseBackstory}\n\n${description.charAt(0).toUpperCase() + description.slice(1)}.`
    : baseBackstory;
  const treasure = description
    ? `${generateStartingTreasure(background)}\n${description}`
    : generateStartingTreasure(background);

  // Spellcasting
  const spellInfo = generateSpellcasting(cls, abilities, level, profBonus);

  return {
    name,
    race: RACE_NAMES[race] ?? race,
    raceIndex: race,
    class: CLASS_NAMES[cls] ?? cls,
    classIndex: cls,
    level,
    background,
    alignment,
    abilities,
    hp: Math.max(hp, 1),
    ac: calculateAC(cls, abilities),
    speed: RACE_SPEED[race] ?? 30,
    hitDie: `${level}d${hitDie}`,
    profBonus,
    saveProficiencies,
    skillProficiencies,
    equipment,
    weapons,
    proficienciesAndLanguages,
    racialTraits,
    classFeatures: classFeats,
    personalityTrait: pickRandom(PERSONALITY_TRAITS[background] ?? ['Adventurous and bold.']),
    ideal: IDEALS[background] ?? 'Adventure. Life is meant to be lived!',
    bond: BONDS[background] ?? 'I seek to prove myself worthy of my companions.',
    flaw: FLAWS[background] ?? 'I follow my gut, even when it leads me astray.',
    // Page 2
    age: appearance.age,
    height: appearance.height,
    weight: appearance.weight,
    eyes: appearance.eyes,
    skin: appearance.skin,
    hair: appearance.hair,
    backstory,
    allies: BACKGROUND_ALLIES[background]?.allies ?? 'None yet — adventures await.',
    factionName: BACKGROUND_ALLIES[background]?.faction ?? '',
    treasure,
    // Page 3
    ...spellInfo,
  };
}

const RACE_ALIASES: Record<string, string> = {
  dragonborn: 'dragonborn', dragon: 'dragonborn', dwarf: 'dwarf', dwarven: 'dwarf',
  elf: 'elf', elven: 'elf', elfish: 'elf', gnome: 'gnome', halfelf: 'half-elf',
  halforc: 'half-orc', halfling: 'halfling', hobbit: 'halfling', human: 'human',
  tiefling: 'tiefling',
};

const CLASS_ALIASES: Record<string, string> = {
  barbarian: 'barbarian', barb: 'barbarian', bard: 'bard', cleric: 'cleric', druid: 'druid',
  fighter: 'fighter', monk: 'monk', paladin: 'paladin', pally: 'paladin', ranger: 'ranger',
  rogue: 'rogue', thief: 'rogue', sorcerer: 'sorcerer', sorc: 'sorcerer',
  warlock: 'warlock', lock: 'warlock', wizard: 'wizard', mage: 'wizard', wiz: 'wizard',
};

function resolveArg(arg: string): { type: 'race'; index: string } | { type: 'class'; index: string } | null {
  const lower = arg.toLowerCase().replace(/[-\s]/g, '');
  if (RACE_ALIASES[lower]) return { type: 'race', index: RACE_ALIASES[lower] };
  if (CLASS_ALIASES[lower]) return { type: 'class', index: CLASS_ALIASES[lower] };
  return null;
}

interface CharacterArgs {
  race?: string;
  class?: string;
  name?: string;
  level?: number;
  alignment?: string;
  background?: string;
  description?: string;
}

// Alignment strings for detection (lowercase)
const ALIGNMENT_STRINGS: Record<string, string> = {
  'lawful good': 'Lawful Good', 'neutral good': 'Neutral Good', 'chaotic good': 'Chaotic Good',
  'lawful neutral': 'Lawful Neutral', 'true neutral': 'Neutral', 'chaotic neutral': 'Chaotic Neutral',
  'lawful evil': 'Lawful Evil', 'neutral evil': 'Neutral Evil', 'chaotic evil': 'Chaotic Evil',
};

// Background strings for detection (lowercase → display)
const BACKGROUND_STRINGS: Record<string, string> = {
  acolyte: 'Acolyte', criminal: 'Criminal', 'folk hero': 'Folk Hero', noble: 'Noble',
  sage: 'Sage', soldier: 'Soldier', charlatan: 'Charlatan', entertainer: 'Entertainer',
  'guild artisan': 'Guild Artisan', hermit: 'Hermit', outlander: 'Outlander', sailor: 'Sailor',
};

/** Parse user input into race/class/name/level/alignment/background + remaining description */
export function parseCharacterArgs(input: string): CharacterArgs {
  let remaining = input.trim();
  const result: CharacterArgs = {};

  // Extract "named X" / "name X" / "called X" — take the next word
  const nameMatch = remaining.match(/\b(?:named?|called)\s+([a-z''-]+)/i);
  if (nameMatch) {
    result.name = nameMatch[1].charAt(0).toUpperCase() + nameMatch[1].slice(1);
    remaining = remaining.replace(nameMatch[0], ' ');
  }

  // Extract "level N" / "lvl N" / "lv N"
  const levelMatch = remaining.match(/\b(?:level|lvl|lv)\s*(\d+)/i);
  if (levelMatch) {
    const lvl = Math.max(1, Math.min(20, parseInt(levelMatch[1], 10)));
    result.level = lvl;
    remaining = remaining.replace(levelMatch[0], ' ');
  }

  // Extract alignment (two-word combos checked first, then standalone "neutral")
  const lowerRemaining = remaining.toLowerCase();
  for (const [key, display] of Object.entries(ALIGNMENT_STRINGS)) {
    if (lowerRemaining.includes(key)) {
      result.alignment = display;
      remaining = remaining.replace(new RegExp(key.replace(/\s+/g, '\\s+'), 'i'), ' ');
      break;
    }
  }

  // Extract background (two-word backgrounds first, then single-word)
  const twoWordBackgrounds = Object.keys(BACKGROUND_STRINGS).filter((k) => k.includes(' '));
  const oneWordBackgrounds = Object.keys(BACKGROUND_STRINGS).filter((k) => !k.includes(' '));
  for (const key of [...twoWordBackgrounds, ...oneWordBackgrounds]) {
    const bgPattern = new RegExp(`\\b${key.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (bgPattern.test(remaining)) {
      // Don't match "noble" if it's part of race/class (it isn't, but be safe)
      result.background = BACKGROUND_STRINGS[key];
      remaining = remaining.replace(bgPattern, ' ');
      break;
    }
  }

  // Now parse remaining words for race/class
  const args = remaining.split(/\s+/).filter(Boolean);
  const descriptionWords: string[] = [];

  for (const arg of args) {
    if (arg.toLowerCase() === 'random') continue;
    const resolved = resolveArg(arg);
    if (resolved?.type === 'race' && !result.race) result.race = resolved.index;
    else if (resolved?.type === 'class' && !result.class) result.class = resolved.index;
    else descriptionWords.push(arg);
  }

  const description = descriptionWords.join(' ').trim() || undefined;
  if (description) result.description = description;

  return result;
}

// ── Text Summary ────────────────────────────────────────────────────

/** Format a short WhatsApp summary for a generated character sheet. */
export function formatCharacterSummary(char: CharacterData): string {
  const modStr = (ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha') => {
    const mod = abilityModifier(char.abilities[ability]);
    return `${char.abilities[ability]} (${formatModifier(mod)})`;
  };

  const lines: string[] = [
    `*${char.name}* — ${char.race} ${char.class} (Level ${char.level})`,
    `_${char.alignment} · ${char.background}_`,
    '',
    `*STR* ${modStr('str')} | *DEX* ${modStr('dex')} | *CON* ${modStr('con')}`,
    `*INT* ${modStr('int')} | *WIS* ${modStr('wis')} | *CHA* ${modStr('cha')}`,
    '',
    `*HP:* ${char.hp} | *AC:* ${char.ac} | *Speed:* ${char.speed}ft | *Prof:* +${char.profBonus}`,
    `*Skills:* ${char.skillProficiencies.join(', ')}`,
    '',
    `_Full character sheet attached as PDF._`,
  ];

  return lines.join('\n');
}

// ── Public Handler ──────────────────────────────────────────────────

export interface CharacterResult {
  summary: string;
  pdfBytes: Uint8Array;
  fileName: string;
  hasEmptyFields: boolean;
}

/**
 * Handle character creation command.
 * Returns either a CharacterResult (with PDF) or an error string.
 */
export async function handleCharacter(query: string): Promise<CharacterResult | string> {
  const trimmed = query.trim();

  if (trimmed === 'help' || trimmed === '?') return getCharacterHelp();

  try {
    const args = parseCharacterArgs(trimmed);
    const char = generateCharacter(args);

    logger.info({
      name: char.name,
      race: char.race,
      class: char.class,
      stats: char.abilities,
    }, 'Generating character sheet');

    const pdfResult = await generateCharacterPDF(char);
    const fileName = `${char.name}_${char.race}_${char.class}_Lvl${char.level}.pdf`;

    return {
      summary: formatCharacterSummary(char),
      pdfBytes: pdfResult.pdfBytes,
      fileName,
      hasEmptyFields: pdfResult.emptyFields.length > 0,
    };
  } catch (err) {
    logger.error({ err, query: trimmed }, 'Character generation failed');
    return '🎲 Character generation failed. Try again or use !character help.';
  }
}

function getCharacterHelp(): string {
  return [
    '🎲 *D&D 5e Character Generator*',
    '',
    '  !character — fully random Level 1 character',
    '  !character elf wizard — specify race and/or class',
    '  !character rogue level 5 — set level (1-20)',
    '  !character named Bilbo halfling rogue — set name',
    '  !character dwarf fighter chaotic good — set alignment',
    '  !character human sage wizard — set background',
    '  !character halfling rogue with a stolen fortune — add flavor text',
    '',
    '*Races:* Dragonborn, Dwarf, Elf, Gnome, Half-Elf, Half-Orc, Halfling, Human, Tiefling',
    '*Classes:* Barbarian, Bard, Cleric, Druid, Fighter, Monk, Paladin, Ranger, Rogue, Sorcerer, Warlock, Wizard',
    '*Backgrounds:* Acolyte, Charlatan, Criminal, Entertainer, Folk Hero, Guild Artisan, Hermit, Noble, Outlander, Sage, Sailor, Soldier',
    '',
    '_Generates a filled official 5e character sheet PDF._',
  ].join('\n');
}
