/**
 * D&D 5e Character Sheet Generator — random character creation with PDF output.
 *
 * Uses the official WotC fillable character sheet template + pdf-lib to populate fields.
 * Pulls race/class data from dnd5eapi.co for accuracy.
 *
 * Commands:
 *   !character                    — fully random Level 1 character
 *   !character elf wizard         — random with specified race and/or class
 *   !character dwarf              — random with specified race, random class
 *   !character paladin            — random with specified class, random race
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PDFDocument } from 'pdf-lib';
import { logger } from '../middleware/logger.js';
import { PROJECT_ROOT } from '../utils/config.js';

const TEMPLATE_PATH = resolve(PROJECT_ROOT, 'templates', '5e-character-sheet.pdf');

// ── SRD Data ────────────────────────────────────────────────────────

const SRD_RACES = [
  'dragonborn', 'dwarf', 'elf', 'gnome', 'half-elf', 'half-orc',
  'halfling', 'human', 'tiefling',
] as const;

const SRD_CLASSES = [
  'barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk',
  'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard',
] as const;

const BACKGROUNDS = [
  'Acolyte', 'Criminal', 'Folk Hero', 'Noble', 'Sage', 'Soldier',
  'Charlatan', 'Entertainer', 'Guild Artisan', 'Hermit', 'Outlander', 'Sailor',
] as const;

const ALIGNMENTS = [
  'Lawful Good', 'Neutral Good', 'Chaotic Good',
  'Lawful Neutral', 'Neutral', 'Chaotic Neutral',
  'Lawful Evil', 'Neutral Evil', 'Chaotic Evil',
] as const;

// Ability score → skill mapping
const SKILL_ABILITIES: Record<string, AbilityName> = {
  Acrobatics: 'dex', 'Animal Handling': 'wis', Arcana: 'int',
  Athletics: 'str', Deception: 'cha', History: 'int',
  Insight: 'wis', Intimidation: 'cha', Investigation: 'int',
  Medicine: 'wis', Nature: 'int', Perception: 'wis',
  Performance: 'cha', Persuasion: 'cha', Religion: 'int',
  'Sleight of Hand': 'dex', Stealth: 'dex', Survival: 'wis',
};

const ALL_SKILLS = Object.keys(SKILL_ABILITIES);

type AbilityName = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

// Class → primary ability for stat priority
const CLASS_PRIMARY_ABILITIES: Record<string, AbilityName[]> = {
  barbarian: ['str', 'con', 'dex'],
  bard: ['cha', 'dex', 'con'],
  cleric: ['wis', 'con', 'str'],
  druid: ['wis', 'con', 'dex'],
  fighter: ['str', 'con', 'dex'],
  monk: ['dex', 'wis', 'con'],
  paladin: ['str', 'cha', 'con'],
  ranger: ['dex', 'wis', 'con'],
  rogue: ['dex', 'int', 'cha'],
  sorcerer: ['cha', 'con', 'dex'],
  warlock: ['cha', 'con', 'dex'],
  wizard: ['int', 'con', 'dex'],
};

// Class → saving throw proficiencies
const CLASS_SAVE_PROFICIENCIES: Record<string, AbilityName[]> = {
  barbarian: ['str', 'con'],
  bard: ['dex', 'cha'],
  cleric: ['wis', 'cha'],
  druid: ['int', 'wis'],
  fighter: ['str', 'con'],
  monk: ['str', 'dex'],
  paladin: ['wis', 'cha'],
  ranger: ['str', 'dex'],
  rogue: ['dex', 'int'],
  sorcerer: ['con', 'cha'],
  warlock: ['wis', 'cha'],
  wizard: ['int', 'wis'],
};

// Class → skill proficiency options + how many to pick
const CLASS_SKILL_OPTIONS: Record<string, { choose: number; from: string[] }> = {
  barbarian: { choose: 2, from: ['Animal Handling', 'Athletics', 'Intimidation', 'Nature', 'Perception', 'Survival'] },
  bard: { choose: 3, from: ALL_SKILLS },
  cleric: { choose: 2, from: ['History', 'Insight', 'Medicine', 'Persuasion', 'Religion'] },
  druid: { choose: 2, from: ['Arcana', 'Animal Handling', 'Insight', 'Medicine', 'Nature', 'Perception', 'Religion', 'Survival'] },
  fighter: { choose: 2, from: ['Acrobatics', 'Animal Handling', 'Athletics', 'History', 'Insight', 'Intimidation', 'Perception', 'Survival'] },
  monk: { choose: 2, from: ['Acrobatics', 'Athletics', 'History', 'Insight', 'Religion', 'Stealth'] },
  paladin: { choose: 2, from: ['Athletics', 'Insight', 'Intimidation', 'Medicine', 'Persuasion', 'Religion'] },
  ranger: { choose: 3, from: ['Animal Handling', 'Athletics', 'Insight', 'Investigation', 'Nature', 'Perception', 'Stealth', 'Survival'] },
  rogue: { choose: 4, from: ['Acrobatics', 'Athletics', 'Deception', 'Insight', 'Intimidation', 'Investigation', 'Perception', 'Performance', 'Persuasion', 'Sleight of Hand', 'Stealth'] },
  sorcerer: { choose: 2, from: ['Arcana', 'Deception', 'Insight', 'Intimidation', 'Persuasion', 'Religion'] },
  warlock: { choose: 2, from: ['Arcana', 'Deception', 'History', 'Intimidation', 'Investigation', 'Nature', 'Religion'] },
  wizard: { choose: 2, from: ['Arcana', 'History', 'Insight', 'Investigation', 'Medicine', 'Religion'] },
};

// Class → starting equipment (simplified for Level 1)
const CLASS_EQUIPMENT: Record<string, string> = {
  barbarian: 'Greataxe, 2 Handaxes, Explorer\'s Pack, 4 Javelins',
  bard: 'Rapier, Diplomat\'s Pack, Lute, Leather Armor, Dagger',
  cleric: 'Mace, Scale Mail, Light Crossbow, 20 Bolts, Priest\'s Pack, Shield, Holy Symbol',
  druid: 'Wooden Shield, Scimitar, Leather Armor, Explorer\'s Pack, Druidic Focus',
  fighter: 'Chain Mail, Shield, Longsword, Light Crossbow, 20 Bolts, Dungeoneer\'s Pack',
  monk: 'Shortsword, Dungeoneer\'s Pack, 10 Darts',
  paladin: 'Chain Mail, Shield, Longsword, 5 Javelins, Priest\'s Pack, Holy Symbol',
  ranger: 'Scale Mail, 2 Shortswords, Dungeoneer\'s Pack, Longbow, Quiver, 20 Arrows',
  rogue: 'Rapier, Shortbow, Quiver, 20 Arrows, Burglar\'s Pack, Leather Armor, 2 Daggers, Thieves\' Tools',
  sorcerer: 'Light Crossbow, 20 Bolts, Arcane Focus, Dungeoneer\'s Pack, 2 Daggers',
  warlock: 'Light Crossbow, 20 Bolts, Arcane Focus, Scholar\'s Pack, Leather Armor, Any Simple Weapon, 2 Daggers',
  wizard: 'Quarterstaff, Arcane Focus, Scholar\'s Pack, Spellbook',
};

// Class → primary weapon for sheet slots
const CLASS_WEAPONS: Record<string, Array<{ name: string; atk: string; dmg: string }>> = {
  barbarian: [{ name: 'Greataxe', atk: '+5', dmg: '1d12+3 S' }, { name: 'Handaxe', atk: '+5', dmg: '1d6+3 S' }],
  bard: [{ name: 'Rapier', atk: '+5', dmg: '1d8+3 P' }, { name: 'Dagger', atk: '+5', dmg: '1d4+3 P' }],
  cleric: [{ name: 'Mace', atk: '+4', dmg: '1d6+2 B' }, { name: 'Lt. Crossbow', atk: '+2', dmg: '1d8 P' }],
  druid: [{ name: 'Scimitar', atk: '+4', dmg: '1d6+2 S' }],
  fighter: [{ name: 'Longsword', atk: '+5', dmg: '1d8+3 S' }, { name: 'Lt. Crossbow', atk: '+2', dmg: '1d8 P' }],
  monk: [{ name: 'Shortsword', atk: '+5', dmg: '1d6+3 P' }, { name: 'Unarmed', atk: '+5', dmg: '1d4+3 B' }],
  paladin: [{ name: 'Longsword', atk: '+5', dmg: '1d8+3 S' }, { name: 'Javelin', atk: '+5', dmg: '1d6+3 P' }],
  ranger: [{ name: 'Shortsword', atk: '+5', dmg: '1d6+3 P' }, { name: 'Longbow', atk: '+5', dmg: '1d8+3 P' }],
  rogue: [{ name: 'Rapier', atk: '+5', dmg: '1d8+3 P' }, { name: 'Shortbow', atk: '+5', dmg: '1d6+3 P' }],
  sorcerer: [{ name: 'Lt. Crossbow', atk: '+2', dmg: '1d8 P' }, { name: 'Dagger', atk: '+4', dmg: '1d4+2 P' }],
  warlock: [{ name: 'Lt. Crossbow', atk: '+2', dmg: '1d8 P' }, { name: 'Dagger', atk: '+4', dmg: '1d4+2 P' }],
  wizard: [{ name: 'Quarterstaff', atk: '+2', dmg: '1d6 B' }],
};

// Names for flavor
const FIRST_NAMES: Record<string, string[]> = {
  dragonborn: ['Arjhan', 'Balasar', 'Bharash', 'Donaar', 'Ghesh', 'Heskan', 'Medrash', 'Nadarr', 'Pandjed', 'Rhogar', 'Shamash', 'Shedinn', 'Torinn'],
  dwarf: ['Adrik', 'Baern', 'Bruenor', 'Dain', 'Eberk', 'Flint', 'Gardain', 'Harbek', 'Orsik', 'Rurik', 'Tordek', 'Traubon', 'Ulfgar', 'Vondal'],
  elf: ['Adran', 'Aelar', 'Aramil', 'Arannis', 'Berrian', 'Enna', 'Galinndan', 'Hadarai', 'Immeral', 'Laucian', 'Mindartis', 'Quarion', 'Riardon', 'Thia'],
  gnome: ['Alvyn', 'Boddynock', 'Brocc', 'Burgell', 'Dimble', 'Eldon', 'Erky', 'Fonkin', 'Frug', 'Gimble', 'Glim', 'Jebeddo', 'Kellen', 'Wrenn', 'Zook'],
  'half-elf': ['Ander', 'Erevan', 'Galinndan', 'Kieran', 'Lucan', 'Mialee', 'Naivara', 'Quelenna', 'Sariel', 'Shanairra', 'Theren', 'Varis'],
  'half-orc': ['Dench', 'Feng', 'Gell', 'Henk', 'Holg', 'Imsh', 'Keth', 'Krusk', 'Ront', 'Shump', 'Thokk'],
  halfling: ['Alton', 'Beau', 'Cade', 'Corrin', 'Eldon', 'Finnan', 'Garret', 'Lidda', 'Milo', 'Osborn', 'Roscoe', 'Wellby'],
  human: ['Ander', 'Bran', 'Dorn', 'Eldric', 'Falk', 'Grigor', 'Helm', 'Kara', 'Lena', 'Mara', 'Nils', 'Perren', 'Quinn', 'Rowan', 'Theron'],
  tiefling: ['Akta', 'Bryseis', 'Criella', 'Damakos', 'Ekemon', 'Kairon', 'Leucis', 'Makarios', 'Nemeia', 'Orianna', 'Rieta', 'Therai'],
};

// Personality traits by background (2 per background, pick 1)
const PERSONALITY_TRAITS: Record<string, string[]> = {
  Acolyte: ['I idolize a particular hero of my faith, and constantly refer to that person\'s deeds.', 'Nothing can shake my optimistic attitude.'],
  Criminal: ['I always have a plan for what to do when things go wrong.', 'I am always calm, no matter what the situation.'],
  'Folk Hero': ['I judge people by their actions, not their words.', 'If someone is in trouble, I\'m always ready to lend help.'],
  Noble: ['My eloquent flattery makes everyone I talk to feel wonderful.', 'I take great pains to always look my best.'],
  Sage: ['I\'m used to helping out those who aren\'t as smart as I am.', 'I\'ve read every book in the world\'s greatest libraries.'],
  Soldier: ['I\'m always polite and respectful.', 'I\'ve lost too many friends, and I\'m slow to make new ones.'],
  Charlatan: ['I fall in and out of love easily, and am always pursuing someone.', 'I have a joke for every occasion.'],
  Entertainer: ['I know a story relevant to almost every situation.', 'I change my mood or my mind as quickly as I change a tune.'],
  'Guild Artisan': ['I believe that anything worth doing is worth doing right.', 'I\'m a snob who looks down on those who can\'t appreciate fine art.'],
  Hermit: ['I feel tremendous empathy for all who suffer.', 'I often get lost in my own thoughts and contemplation.'],
  Outlander: ['I\'m driven by a wanderlust that led me away from home.', 'I watch over my friends as if they were a litter of newborn pups.'],
  Sailor: ['My friends know they can rely on me, no matter what.', 'I stretch the truth for a good story.'],
};

const IDEALS: Record<string, string> = {
  Acolyte: 'Faith. I trust that my deity will guide my actions.',
  Criminal: 'Freedom. Chains are meant to be broken.',
  'Folk Hero': 'Respect. People deserve to be treated with dignity.',
  Noble: 'Responsibility. It is my duty to respect the authority of those above me.',
  Sage: 'Knowledge. The path to power and self-improvement is through knowledge.',
  Soldier: 'Greater Good. Our lot is to lay down our lives in defense of others.',
  Charlatan: 'Independence. I am a free spirit — no one tells me what to do.',
  Entertainer: 'Beauty. When I perform, I make the world better than it was.',
  'Guild Artisan': 'Community. Everyone\'s duty is to strengthen the bonds of community.',
  Hermit: 'Free Thinking. Inquiry and curiosity are the pillars of progress.',
  Outlander: 'Glory. I must earn glory in battle, for myself and my clan.',
  Sailor: 'Freedom. The sea is freedom — the freedom to go anywhere and do anything.',
};

const BONDS: Record<string, string> = {
  Acolyte: 'I would die to recover an ancient relic of my faith.',
  Criminal: 'Someone I loved died because of a mistake I made.',
  'Folk Hero': 'I protect those who cannot protect themselves.',
  Noble: 'I will face any challenge to win the approval of my family.',
  Sage: 'I\'ve been searching my whole life for the answer to a certain question.',
  Soldier: 'I\'ll never forget the crushing defeat my company suffered.',
  Charlatan: 'I owe everything to my mentor — a horrible person who\'s probably rotting in jail.',
  Entertainer: 'My instrument is my most treasured possession.',
  'Guild Artisan': 'I owe my guild a great debt for forging me into the person I am today.',
  Hermit: 'I entered seclusion because I loved someone I could not have.',
  Outlander: 'My family, clan, or tribe is the most important thing in my life.',
  Sailor: 'I was cheated out of my fair share of the profits, and I want to get my due.',
};

const FLAWS: Record<string, string> = {
  Acolyte: 'I judge others harshly, and myself even more severely.',
  Criminal: 'When I see something valuable, I can\'t think about anything but how to steal it.',
  'Folk Hero': 'I\'m convinced of the significance of my destiny, and blind to my shortcomings.',
  Noble: 'I secretly believe that everyone is beneath me.',
  Sage: 'I am easily distracted by the promise of information.',
  Soldier: 'I\'d rather eat my armor than admit when I\'m wrong.',
  Charlatan: 'I can\'t resist swindling people who are more powerful than me.',
  Entertainer: 'I\'ll do anything to win fame and renown.',
  'Guild Artisan': 'I\'ll do anything to get my hands on something rare or priceless.',
  Hermit: 'I harbor dark, bloodthirsty thoughts that my isolation failed to quell.',
  Outlander: 'I am slow to trust members of other races, tribes, and societies.',
  Sailor: 'Once I start drinking, it\'s hard for me to stop.',
};

// ── Stat Generation ─────────────────────────────────────────────────

export interface AbilityScores {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

/** Roll 4d6, drop lowest */
export function roll4d6DropLowest(): number {
  const rolls = Array.from({ length: 4 }, () => Math.floor(Math.random() * 6) + 1);
  rolls.sort((a, b) => a - b);
  return rolls[1] + rolls[2] + rolls[3]; // drop lowest
}

/** Calculate ability modifier */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** Format modifier as +N or -N */
export function formatModifier(mod: number): string {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

/** Generate 6 ability scores, assign to abilities based on class priority */
export function generateAbilityScores(classIndex: string): AbilityScores {
  const rolls = Array.from({ length: 6 }, roll4d6DropLowest);
  rolls.sort((a, b) => b - a); // Highest first

  const priority = CLASS_PRIMARY_ABILITIES[classIndex] ?? ['str', 'dex', 'con'];
  const remaining: AbilityName[] = (['str', 'dex', 'con', 'int', 'wis', 'cha'] as AbilityName[])
    .filter((a) => !priority.includes(a));

  // Shuffle remaining to avoid predictability
  for (let i = remaining.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
  }

  const order = [...priority, ...remaining];
  const scores: Record<string, number> = {};
  for (let i = 0; i < 6; i++) {
    scores[order[i]] = rolls[i];
  }

  return scores as unknown as AbilityScores;
}

/** Apply racial ability bonuses */
export function applyRacialBonuses(scores: AbilityScores, raceIndex: string): AbilityScores {
  // Hardcoded racial bonuses from SRD (faster than API call)
  const RACIAL_BONUSES: Record<string, Partial<AbilityScores>> = {
    dragonborn: { str: 2, cha: 1 },
    dwarf: { con: 2 },
    elf: { dex: 2 },
    gnome: { int: 2 },
    'half-elf': { cha: 2 },  // +1 to two others (randomized below)
    'half-orc': { str: 2, con: 1 },
    halfling: { dex: 2 },
    human: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 },
    tiefling: { int: 1, cha: 2 },
  };

  const raceBonuses = RACIAL_BONUSES[raceIndex] ?? {};
  const result = { ...scores };

  for (const [ability, bonus] of Object.entries(raceBonuses)) {
    result[ability as AbilityName] += bonus;
  }

  // Half-elf gets +1 to two abilities (not CHA)
  if (raceIndex === 'half-elf') {
    const options: AbilityName[] = ['str', 'dex', 'con', 'int', 'wis'];
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }
    result[options[0]] += 1;
    result[options[1]] += 1;
  }

  return result;
}

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickRandomN<T>(arr: readonly T[], n: number): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

// ── Character Data ──────────────────────────────────────────────────

export interface CharacterData {
  name: string;
  race: string;
  raceIndex: string;
  class: string;
  classIndex: string;
  level: number;
  background: string;
  alignment: string;
  abilities: AbilityScores;
  hp: number;
  ac: number;
  speed: number;
  hitDie: string;
  profBonus: number;
  saveProficiencies: AbilityName[];
  skillProficiencies: string[];
  equipment: string;
  weapons: Array<{ name: string; atk: string; dmg: string }>;
  proficienciesAndLanguages: string;
  features: string;
  personalityTrait: string;
  ideal: string;
  bond: string;
  flaw: string;
}

// Race → speed
const RACE_SPEED: Record<string, number> = {
  dragonborn: 30, dwarf: 25, elf: 30, gnome: 25, 'half-elf': 30,
  'half-orc': 30, halfling: 25, human: 30, tiefling: 30,
};

// Race → display name
const RACE_NAMES: Record<string, string> = {
  dragonborn: 'Dragonborn', dwarf: 'Dwarf', elf: 'Elf', gnome: 'Gnome',
  'half-elf': 'Half-Elf', 'half-orc': 'Half-Orc', halfling: 'Halfling',
  human: 'Human', tiefling: 'Tiefling',
};

// Class → display name
const CLASS_NAMES: Record<string, string> = {
  barbarian: 'Barbarian', bard: 'Bard', cleric: 'Cleric', druid: 'Druid',
  fighter: 'Fighter', monk: 'Monk', paladin: 'Paladin', ranger: 'Ranger',
  rogue: 'Rogue', sorcerer: 'Sorcerer', warlock: 'Warlock', wizard: 'Wizard',
};

// Class → hit die
const CLASS_HIT_DIE: Record<string, number> = {
  barbarian: 12, bard: 8, cleric: 8, druid: 8, fighter: 10, monk: 8,
  paladin: 10, ranger: 10, rogue: 8, sorcerer: 6, warlock: 8, wizard: 6,
};

// Race → traits
const RACE_TRAITS: Record<string, string> = {
  dragonborn: 'Breath Weapon, Damage Resistance (based on ancestry)',
  dwarf: 'Darkvision 60ft, Dwarven Resilience, Stonecunning',
  elf: 'Darkvision 60ft, Fey Ancestry, Trance, Keen Senses',
  gnome: 'Darkvision 60ft, Gnome Cunning',
  'half-elf': 'Darkvision 60ft, Fey Ancestry, Skill Versatility',
  'half-orc': 'Darkvision 60ft, Relentless Endurance, Savage Attacks',
  halfling: 'Lucky, Brave, Halfling Nimbleness',
  human: 'Extra Language',
  tiefling: 'Darkvision 60ft, Hellish Resistance, Infernal Legacy',
};

// Race → languages
const RACE_LANGUAGES: Record<string, string> = {
  dragonborn: 'Common, Draconic',
  dwarf: 'Common, Dwarvish',
  elf: 'Common, Elvish',
  gnome: 'Common, Gnomish',
  'half-elf': 'Common, Elvish, +1 of choice',
  'half-orc': 'Common, Orc',
  halfling: 'Common, Halfling',
  human: 'Common, +1 of choice',
  tiefling: 'Common, Infernal',
};

// Class → Level 1 features
const CLASS_FEATURES: Record<string, string> = {
  barbarian: 'Rage (2/day), Unarmored Defense',
  bard: 'Spellcasting, Bardic Inspiration (d6)',
  cleric: 'Spellcasting, Divine Domain',
  druid: 'Druidic, Spellcasting',
  fighter: 'Fighting Style, Second Wind',
  monk: 'Unarmored Defense, Martial Arts (d4)',
  paladin: 'Divine Sense, Lay on Hands (5 HP)',
  ranger: 'Favored Enemy, Natural Explorer',
  rogue: 'Expertise, Sneak Attack (1d6), Thieves\' Cant',
  sorcerer: 'Spellcasting, Sorcerous Origin',
  warlock: 'Otherworldly Patron, Pact Magic',
  wizard: 'Spellcasting, Arcane Recovery',
};

// AC calculation by class
function calculateAC(classIndex: string, abilities: AbilityScores): number {
  const dexMod = abilityModifier(abilities.dex);
  switch (classIndex) {
    case 'barbarian': return 10 + dexMod + abilityModifier(abilities.con); // Unarmored
    case 'monk': return 10 + dexMod + abilityModifier(abilities.wis); // Unarmored
    case 'bard': case 'rogue': case 'warlock': return 11 + dexMod; // Leather
    case 'ranger': case 'cleric': return 14 + Math.min(dexMod, 2); // Scale mail
    case 'druid': return 11 + dexMod; // Leather
    case 'fighter': case 'paladin': return 16; // Chain mail (no dex bonus)
    case 'sorcerer': case 'wizard': return 10 + dexMod; // No armor
    default: return 10 + dexMod;
  }
}

/** Generate a complete Level 1 character */
export function generateCharacter(raceIndex?: string, classIndex?: string): CharacterData {
  const race = raceIndex && SRD_RACES.includes(raceIndex as typeof SRD_RACES[number])
    ? raceIndex
    : pickRandom(SRD_RACES);
  const cls = classIndex && SRD_CLASSES.includes(classIndex as typeof SRD_CLASSES[number])
    ? classIndex
    : pickRandom(SRD_CLASSES);

  const baseScores = generateAbilityScores(cls);
  const abilities = applyRacialBonuses(baseScores, race);

  const hitDie = CLASS_HIT_DIE[cls] ?? 8;
  const conMod = abilityModifier(abilities.con);
  const hp = hitDie + conMod;

  const background = pickRandom(BACKGROUNDS);
  const alignment = pickRandom(ALIGNMENTS);

  const saveProficiencies = CLASS_SAVE_PROFICIENCIES[cls] ?? ['str', 'con'];
  const skillOptions = CLASS_SKILL_OPTIONS[cls] ?? { choose: 2, from: ALL_SKILLS };
  const skillProficiencies = pickRandomN(skillOptions.from, skillOptions.choose);

  const name = pickRandom(FIRST_NAMES[race] ?? FIRST_NAMES.human);
  const weapons = CLASS_WEAPONS[cls] ?? [];
  const equipment = CLASS_EQUIPMENT[cls] ?? '';

  const raceTraits = RACE_TRAITS[race] ?? '';
  const classFeatures = CLASS_FEATURES[cls] ?? '';
  const features = [raceTraits, classFeatures].filter(Boolean).join('\n');

  const languages = RACE_LANGUAGES[race] ?? 'Common';
  const proficienciesAndLanguages = `Languages: ${languages}\n\nArmor: ${getArmorProficiencies(cls)}\nWeapons: ${getWeaponProficiencies(cls)}`;

  return {
    name,
    race: RACE_NAMES[race] ?? race,
    raceIndex: race,
    class: CLASS_NAMES[cls] ?? cls,
    classIndex: cls,
    level: 1,
    background,
    alignment,
    abilities,
    hp: Math.max(hp, 1),
    ac: calculateAC(cls, abilities),
    speed: RACE_SPEED[race] ?? 30,
    hitDie: `1d${hitDie}`,
    profBonus: 2,
    saveProficiencies,
    skillProficiencies,
    equipment,
    weapons,
    proficienciesAndLanguages,
    features,
    personalityTrait: pickRandom(PERSONALITY_TRAITS[background] ?? ['Adventurous and bold.']),
    ideal: IDEALS[background] ?? 'Adventure. Life is meant to be lived!',
    bond: BONDS[background] ?? 'I seek to prove myself worthy of my companions.',
    flaw: FLAWS[background] ?? 'I follow my gut, even when it leads me astray.',
  };
}

function getArmorProficiencies(classIndex: string): string {
  const map: Record<string, string> = {
    barbarian: 'Light, Medium, Shields',
    bard: 'Light',
    cleric: 'Light, Medium, Shields',
    druid: 'Light, Medium, Shields (nonmetal)',
    fighter: 'All armor, Shields',
    monk: 'None',
    paladin: 'All armor, Shields',
    ranger: 'Light, Medium, Shields',
    rogue: 'Light',
    sorcerer: 'None',
    warlock: 'Light',
    wizard: 'None',
  };
  return map[classIndex] ?? 'None';
}

function getWeaponProficiencies(classIndex: string): string {
  const map: Record<string, string> = {
    barbarian: 'Simple, Martial',
    bard: 'Simple, Hand Crossbow, Longsword, Rapier, Shortsword',
    cleric: 'Simple',
    druid: 'Club, Dagger, Dart, Javelin, Mace, Quarterstaff, Scimitar, Sickle, Sling, Spear',
    fighter: 'Simple, Martial',
    monk: 'Simple, Shortsword',
    paladin: 'Simple, Martial',
    ranger: 'Simple, Martial',
    rogue: 'Simple, Hand Crossbow, Longsword, Rapier, Shortsword',
    sorcerer: 'Dagger, Dart, Sling, Quarterstaff, Lt. Crossbow',
    warlock: 'Simple',
    wizard: 'Dagger, Dart, Sling, Quarterstaff, Lt. Crossbow',
  };
  return map[classIndex] ?? 'Simple';
}

// ── PDF Generation ──────────────────────────────────────────────────

/** Checkbox field name → proficiency mapping */
const SAVE_CHECKBOXES: Record<AbilityName, string> = {
  str: 'Check Box 11',
  dex: 'Check Box 18',
  con: 'Check Box 19',
  int: 'Check Box 20',
  wis: 'Check Box 21',
  cha: 'Check Box 22',
};

const SKILL_CHECKBOXES: Record<string, string> = {
  'Acrobatics': 'Check Box 23',
  'Animal Handling': 'Check Box 24',
  'Arcana': 'Check Box 25',
  'Athletics': 'Check Box 26',
  'Deception': 'Check Box 27',
  'History': 'Check Box 28',
  'Insight': 'Check Box 29',
  'Intimidation': 'Check Box 30',
  'Investigation': 'Check Box 31',
  'Medicine': 'Check Box 32',
  'Nature': 'Check Box 33',
  'Perception': 'Check Box 34',
  'Performance': 'Check Box 35',
  'Persuasion': 'Check Box 36',
  'Religion': 'Check Box 37',
  'Sleight of Hand': 'Check Box 38',
  'Stealth': 'Check Box 39',
  'Survival': 'Check Box 40',
};

/** Skill → PDF text field name */
const SKILL_FIELDS: Record<string, string> = {
  'Acrobatics': 'Acrobatics',
  'Animal Handling': 'Animal',
  'Arcana': 'Arcana',
  'Athletics': 'Athletics',
  'Deception': 'Deception ',     // Trailing space in PDF
  'History': 'History ',          // Trailing space in PDF
  'Insight': 'Insight',
  'Intimidation': 'Intimidation',
  'Investigation': 'Investigation ',  // Trailing space
  'Medicine': 'Medicine',
  'Nature': 'Nature',
  'Perception': 'Perception ',    // Trailing space
  'Performance': 'Performance',
  'Persuasion': 'Persuasion',
  'Religion': 'Religion',
  'Sleight of Hand': 'SleightofHand',
  'Stealth': 'Stealth ',          // Trailing space
  'Survival': 'Survival',
};

/** Fill the WotC 5e character sheet template and return PDF bytes */
export async function generateCharacterPDF(char: CharacterData): Promise<Uint8Array> {
  const templateBytes = readFileSync(TEMPLATE_PATH);
  const doc = await PDFDocument.load(templateBytes);
  const form = doc.getForm();

  // Helper to safely set text fields
  const setText = (fieldName: string, value: string) => {
    try {
      const field = form.getTextField(fieldName);
      field.setText(value);
    } catch (err) {
      logger.debug({ fieldName, err }, 'PDF field not found');
    }
  };

  const setCheck = (fieldName: string) => {
    try {
      const field = form.getCheckBox(fieldName);
      field.check();
    } catch (err) {
      logger.debug({ fieldName, err }, 'PDF checkbox not found');
    }
  };

  // ── Header fields ───────────────────────────────────────────
  setText('CharacterName', char.name);
  setText('ClassLevel', `${char.class} 1`);
  setText('Background', char.background);
  setText('PlayerName', 'Garbanzo Bot');
  setText('Race ', char.race);  // Note trailing space in field name
  setText('Alignment', char.alignment);
  setText('XP', '0');

  // ── Ability scores + modifiers ──────────────────────────────
  const abilityFields: Record<AbilityName, { score: string; mod: string }> = {
    str: { score: 'STR', mod: 'STRmod' },
    dex: { score: 'DEX', mod: 'DEXmod ' },  // Trailing space
    con: { score: 'CON', mod: 'CONmod' },
    int: { score: 'INT', mod: 'INTmod' },
    wis: { score: 'WIS', mod: 'WISmod' },
    cha: { score: 'CHA', mod: 'CHamod' },   // Note: CHamod not CHAmod
  };

  for (const [ability, fields] of Object.entries(abilityFields)) {
    const score = char.abilities[ability as AbilityName];
    const mod = abilityModifier(score);
    setText(fields.score, String(score));
    setText(fields.mod, formatModifier(mod));
  }

  // ── Combat stats ────────────────────────────────────────────
  setText('ProfBonus', '+2');
  setText('AC', String(char.ac));
  setText('Initiative', formatModifier(abilityModifier(char.abilities.dex)));
  setText('Speed', String(char.speed));
  setText('HPMax', String(char.hp));
  setText('HPCurrent', String(char.hp));
  setText('HDTotal', '1');
  setText('HD', `d${CLASS_HIT_DIE[char.classIndex] ?? 8}`);

  // ── Saving throws ───────────────────────────────────────────
  const saveFields: Record<AbilityName, string> = {
    str: 'ST Strength',
    dex: 'ST Dexterity',
    con: 'ST Constitution',
    int: 'ST Intelligence',
    wis: 'ST Wisdom',
    cha: 'ST Charisma',
  };

  for (const ability of ['str', 'dex', 'con', 'int', 'wis', 'cha'] as AbilityName[]) {
    const mod = abilityModifier(char.abilities[ability]);
    const proficient = char.saveProficiencies.includes(ability);
    const total = proficient ? mod + char.profBonus : mod;
    setText(saveFields[ability], formatModifier(total));
    if (proficient) setCheck(SAVE_CHECKBOXES[ability]);
  }

  // ── Skills ──────────────────────────────────────────────────
  for (const skill of ALL_SKILLS) {
    const ability = SKILL_ABILITIES[skill];
    const mod = abilityModifier(char.abilities[ability]);
    const proficient = char.skillProficiencies.includes(skill);
    const total = proficient ? mod + char.profBonus : mod;

    const fieldName = SKILL_FIELDS[skill];
    if (fieldName) setText(fieldName, formatModifier(total));

    if (proficient) {
      const checkName = SKILL_CHECKBOXES[skill];
      if (checkName) setCheck(checkName);
    }
  }

  // ── Passive Perception ──────────────────────────────────────
  const perceptionMod = abilityModifier(char.abilities.wis);
  const perceptionProf = char.skillProficiencies.includes('Perception');
  const passive = 10 + perceptionMod + (perceptionProf ? char.profBonus : 0);
  setText('Passive', String(passive));

  // ── Weapons ─────────────────────────────────────────────────
  if (char.weapons.length > 0) {
    setText('Wpn Name', char.weapons[0].name);
    setText('Wpn1 AtkBonus', char.weapons[0].atk);
    setText('Wpn1 Damage', char.weapons[0].dmg);
  }
  if (char.weapons.length > 1) {
    setText('Wpn Name 2', char.weapons[1].name);
    setText('Wpn2 AtkBonus ', char.weapons[1].atk);  // Trailing space
    setText('Wpn2 Damage ', char.weapons[1].dmg);     // Trailing space
  }
  if (char.weapons.length > 2) {
    setText('Wpn Name 3', char.weapons[2].name);
    setText('Wpn3 AtkBonus  ', char.weapons[2].atk);  // Double trailing space
    setText('Wpn3 Damage ', char.weapons[2].dmg);
  }

  // ── Equipment & features ────────────────────────────────────
  setText('Equipment', char.equipment);
  setText('Features and Traits', char.features);
  setText('ProficienciesLang', char.proficienciesAndLanguages);

  // ── Personality ─────────────────────────────────────────────
  setText('PersonalityTraits ', char.personalityTrait);  // Trailing space
  setText('Ideals', char.ideal);
  setText('Bonds', char.bond);
  setText('Flaws', char.flaw);

  // Flatten the form so it displays correctly on all viewers
  form.flatten();

  return await doc.save();
}

// ── Argument parsing ────────────────────────────────────────────────

/** Try to match a user arg to a race or class index */
function resolveArg(arg: string): { type: 'race'; index: string } | { type: 'class'; index: string } | null {
  const lower = arg.toLowerCase().replace(/[-\s]/g, '');

  // Race aliases
  const raceAliases: Record<string, string> = {
    dragonborn: 'dragonborn', dragon: 'dragonborn',
    dwarf: 'dwarf', dwarven: 'dwarf',
    elf: 'elf', elven: 'elf', elfish: 'elf',
    gnome: 'gnome',
    halfelf: 'half-elf',
    halforc: 'half-orc',
    halfling: 'halfling', hobbit: 'halfling',
    human: 'human',
    tiefling: 'tiefling',
  };

  if (raceAliases[lower]) return { type: 'race', index: raceAliases[lower] };

  // Class aliases
  const classAliases: Record<string, string> = {
    barbarian: 'barbarian', barb: 'barbarian',
    bard: 'bard',
    cleric: 'cleric',
    druid: 'druid',
    fighter: 'fighter',
    monk: 'monk',
    paladin: 'paladin', pally: 'paladin',
    ranger: 'ranger',
    rogue: 'rogue', thief: 'rogue',
    sorcerer: 'sorcerer', sorc: 'sorcerer',
    warlock: 'warlock', lock: 'warlock',
    wizard: 'wizard', mage: 'wizard', wiz: 'wizard',
  };

  if (classAliases[lower]) return { type: 'class', index: classAliases[lower] };

  return null;
}

/** Parse user input into race/class preferences */
export function parseCharacterArgs(input: string): { race?: string; class?: string } {
  const args = input.trim().split(/\s+/).filter(Boolean);
  const result: { race?: string; class?: string } = {};

  for (const arg of args) {
    if (arg.toLowerCase() === 'random') continue; // Skip "random" keyword
    const resolved = resolveArg(arg);
    if (resolved?.type === 'race' && !result.race) result.race = resolved.index;
    else if (resolved?.type === 'class' && !result.class) result.class = resolved.index;
  }

  return result;
}

// ── Text summary (sent alongside PDF) ───────────────────────────────

export function formatCharacterSummary(char: CharacterData): string {
  const modStr = (ability: AbilityName) => {
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

// ── Public handler ──────────────────────────────────────────────────

export interface CharacterResult {
  summary: string;
  pdfBytes: Uint8Array;
  fileName: string;
}

/**
 * Handle character creation command.
 * Returns either a CharacterResult (with PDF) or an error string.
 */
export async function handleCharacter(query: string): Promise<CharacterResult | string> {
  const trimmed = query.trim();

  if (trimmed === 'help' || trimmed === '?') return getCharacterHelp();

  try {
    const { race, class: cls } = parseCharacterArgs(trimmed);
    const char = generateCharacter(race, cls);

    logger.info({
      name: char.name,
      race: char.race,
      class: char.class,
      stats: char.abilities,
    }, 'Generating character sheet');

    const pdfBytes = await generateCharacterPDF(char);
    const fileName = `${char.name}_${char.race}_${char.class}_Lvl1.pdf`;

    return {
      summary: formatCharacterSummary(char),
      pdfBytes,
      fileName,
    };
  } catch (err) {
    logger.error({ err }, 'Character generation failed');
    return '🎲 Character generation failed. Try again or use !character help.';
  }
}

function getCharacterHelp(): string {
  return [
    '🎲 *D&D 5e Character Generator*',
    '',
    '  !character — fully random Level 1 character',
    '  !character elf wizard — specify race and class',
    '  !character dwarf — random class, specific race',
    '  !character rogue — random race, specific class',
    '',
    '*Races:* Dragonborn, Dwarf, Elf, Gnome, Half-Elf, Half-Orc, Halfling, Human, Tiefling',
    '*Classes:* Barbarian, Bard, Cleric, Druid, Fighter, Monk, Paladin, Ranger, Rogue, Sorcerer, Warlock, Wizard',
    '',
    '_Generates a filled official 5e character sheet PDF._',
  ].join('\n');
}
