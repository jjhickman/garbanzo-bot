/**
 * CharacterData interface, race/class metadata tables, appearance generation,
 * backstory generation, treasure, and allies.
 */

import type { AbilityName } from './srd-data.js';
import { pickRandom } from './srd-data.js';
import type { AbilityScores } from './abilities.js';
import { abilityModifier } from './abilities.js';

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
  racialTraits: string;
  classFeatures: string;
  personalityTrait: string;
  ideal: string;
  bond: string;
  flaw: string;
  // Page 2 — appearance
  age: string;
  height: string;
  weight: string;
  eyes: string;
  skin: string;
  hair: string;
  backstory: string;
  allies: string;
  factionName: string;
  treasure: string;
  // Page 3 — spellcasting
  isSpellcaster: boolean;
  spellcastingAbility: string;
  spellSaveDC: number;
  spellAttackBonus: number;
  cantrips: string[];
  level1Spells: string[];
  spellSlots: number[];  // index 0 = level 1 slots, index 1 = level 2, etc.
}

export const RACE_SPEED: Record<string, number> = {
  dragonborn: 30, dwarf: 25, elf: 30, gnome: 25, 'half-elf': 30,
  'half-orc': 30, halfling: 25, human: 30, tiefling: 30,
};

export const RACE_NAMES: Record<string, string> = {
  dragonborn: 'Dragonborn', dwarf: 'Dwarf', elf: 'Elf', gnome: 'Gnome',
  'half-elf': 'Half-Elf', 'half-orc': 'Half-Orc', halfling: 'Halfling',
  human: 'Human', tiefling: 'Tiefling',
};

export const CLASS_NAMES: Record<string, string> = {
  barbarian: 'Barbarian', bard: 'Bard', cleric: 'Cleric', druid: 'Druid',
  fighter: 'Fighter', monk: 'Monk', paladin: 'Paladin', ranger: 'Ranger',
  rogue: 'Rogue', sorcerer: 'Sorcerer', warlock: 'Warlock', wizard: 'Wizard',
};

export const CLASS_HIT_DIE: Record<string, number> = {
  barbarian: 12, bard: 8, cleric: 8, druid: 8, fighter: 10, monk: 8,
  paladin: 10, ranger: 10, rogue: 8, sorcerer: 6, warlock: 8, wizard: 6,
};

export const RACE_TRAITS: Record<string, string> = {
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

export const RACE_LANGUAGES: Record<string, string> = {
  dragonborn: 'Common, Draconic', dwarf: 'Common, Dwarvish', elf: 'Common, Elvish',
  gnome: 'Common, Gnomish', 'half-elf': 'Common, Elvish, +1 of choice',
  'half-orc': 'Common, Orc', halfling: 'Common, Halfling',
  human: 'Common, +1 of choice', tiefling: 'Common, Infernal',
};

export const CLASS_FEATURES: Record<string, string> = {
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

/** Calculate starting armor class from class defaults and ability modifiers. */
export function calculateAC(classIndex: string, abilities: AbilityScores): number {
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

interface AppearanceData { age: string; height: string; weight: string; eyes: string; skin: string; hair: string }

const RACE_AGE_RANGES: Record<string, [number, number]> = {
  dragonborn: [15, 60], dwarf: [50, 350], elf: [100, 750], gnome: [40, 450],
  'half-elf': [20, 180], 'half-orc': [14, 60], halfling: [20, 150],
  human: [18, 80], tiefling: [18, 85],
};

const RACE_SIZE: Record<string, { height: [number, number]; weight: [number, number] }> = {
  dragonborn: { height: [66, 80], weight: [220, 320] },
  dwarf: { height: [48, 56], weight: [130, 170] },
  elf: { height: [60, 72], weight: [100, 145] },
  gnome: { height: [36, 42], weight: [35, 45] },
  'half-elf': { height: [60, 72], weight: [120, 180] },
  'half-orc': { height: [60, 78], weight: [140, 230] },
  halfling: { height: [33, 39], weight: [35, 45] },
  human: { height: [60, 76], weight: [110, 220] },
  tiefling: { height: [60, 72], weight: [110, 200] },
};

const RACE_EYES: Record<string, string[]> = {
  dragonborn: ['Gold', 'Red', 'Orange', 'Amber', 'Silver', 'Copper'],
  dwarf: ['Brown', 'Hazel', 'Gray', 'Amber', 'Dark Brown'],
  elf: ['Green', 'Blue', 'Violet', 'Gold', 'Silver', 'Amber'],
  gnome: ['Blue', 'Green', 'Brown', 'Hazel', 'Turquoise'],
  'half-elf': ['Green', 'Blue', 'Hazel', 'Violet', 'Brown', 'Gold'],
  'half-orc': ['Brown', 'Red', 'Gray', 'Green', 'Amber'],
  halfling: ['Brown', 'Hazel', 'Green', 'Blue'],
  human: ['Brown', 'Blue', 'Green', 'Hazel', 'Gray', 'Amber'],
  tiefling: ['Red', 'Gold', 'Silver', 'Black', 'White', 'Violet'],
};

const RACE_SKIN: Record<string, string[]> = {
  dragonborn: ['Gold', 'Red', 'Bronze', 'Brass', 'Copper', 'Silver', 'Blue', 'Green', 'White', 'Black'],
  dwarf: ['Tan', 'Fair', 'Ruddy', 'Brown', 'Pale'],
  elf: ['Pale', 'Fair', 'Bronze', 'Copper', 'Light Brown'],
  gnome: ['Tan', 'Brown', 'Ruddy', 'Fair'],
  'half-elf': ['Fair', 'Tan', 'Light Brown', 'Olive', 'Pale'],
  'half-orc': ['Gray-Green', 'Green', 'Gray', 'Olive', 'Pale Green'],
  halfling: ['Tan', 'Fair', 'Ruddy', 'Brown'],
  human: ['Fair', 'Tan', 'Brown', 'Dark Brown', 'Olive', 'Pale'],
  tiefling: ['Red', 'Maroon', 'Pale', 'Dusky', 'Lavender', 'Blue-Gray'],
};

const RACE_HAIR: Record<string, string[]> = {
  dragonborn: ['None', 'None', 'None'],  // Most dragonborn are bald
  dwarf: ['Black', 'Brown', 'Red', 'Auburn', 'Gray', 'White'],
  elf: ['Black', 'Blonde', 'Silver', 'Copper', 'White', 'Blue-Black'],
  gnome: ['Red', 'Blonde', 'Brown', 'White', 'Orange'],
  'half-elf': ['Black', 'Brown', 'Blonde', 'Auburn', 'Silver', 'Red'],
  'half-orc': ['Black', 'Dark Brown', 'Gray'],
  halfling: ['Brown', 'Sandy', 'Auburn', 'Black', 'Chestnut'],
  human: ['Black', 'Brown', 'Blonde', 'Red', 'Auburn', 'Gray', 'White'],
  tiefling: ['Black', 'Dark Red', 'Purple', 'Blue-Black', 'Crimson'],
};

function randomInRange(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatHeight(inches: number): string {
  const feet = Math.floor(inches / 12);
  const remaining = inches % 12;
  return `${feet}'${remaining}"`;
}

/** Generate randomized appearance details within race-appropriate ranges. */
export function generateAppearance(raceIndex: string): AppearanceData {
  const ageRange = RACE_AGE_RANGES[raceIndex] ?? [18, 80];
  const size = RACE_SIZE[raceIndex] ?? { height: [60, 76], weight: [110, 220] };
  const eyes = RACE_EYES[raceIndex] ?? RACE_EYES.human;
  const skin = RACE_SKIN[raceIndex] ?? RACE_SKIN.human;
  const hair = RACE_HAIR[raceIndex] ?? RACE_HAIR.human;

  const heightInches = randomInRange(size.height[0], size.height[1]);

  return {
    age: String(randomInRange(ageRange[0], ageRange[1])),
    height: formatHeight(heightInches),
    weight: `${randomInRange(size.weight[0], size.weight[1])} lbs`,
    eyes: pickRandom(eyes),
    skin: pickRandom(skin),
    hair: pickRandom(hair),
  };
}

const BACKSTORY_TEMPLATES: Record<string, string[]> = {
  Acolyte: [
    'Raised in a temple from a young age, {name} devoted {their} life to the study of sacred texts and divine rituals. A vision from {their} deity set {them} on the path of adventure.',
    '{name} served as a temple attendant for years before a crisis of faith drove {them} to seek answers beyond the cloister walls.',
  ],
  Criminal: [
    '{name} grew up on the streets, learning to survive by wit and guile. A job gone wrong forced {them} to flee, seeking a fresh start as an adventurer.',
    'Once part of a notorious thieves\' guild, {name} left that life behind after being betrayed by a trusted partner.',
  ],
  'Folk Hero': [
    'When a tyrant threatened {their} village, {name} stood up and fought back, earning the love of the common folk. Now {they} seek to do good on a grander scale.',
    '{name} performed a deed of great courage that saved {their} community, and the people still sing songs of {their} bravery.',
  ],
  Noble: [
    'Born into a family of wealth and privilege, {name} grew restless with courtly life and set out to prove {their} worth through deeds rather than birthright.',
    '{name} was raised in luxury but a family scandal stripped away {their} title, driving {them} to reclaim honor through adventure.',
  ],
  Sage: [
    '{name} spent years in libraries and academies, amassing knowledge. A discovery in an ancient text revealed a mystery that could only be solved through firsthand exploration.',
    'A scholar of great renown, {name} left the academy when {their} research led to questions that no book could answer.',
  ],
  Soldier: [
    '{name} served with distinction in a military company before being discharged. The skills learned on the battlefield now serve {them} well as an adventurer.',
    'After years of military service, {name} left the ranks seeking purpose beyond following orders.',
  ],
  Charlatan: [
    '{name} made a living through deception and false identities, but a con that went too far forced {them} to reinvent {themselves} once more — this time for real.',
    'A master of disguise and smooth talk, {name} decided the adventuring life offered better rewards than petty schemes.',
  ],
  Entertainer: [
    '{name} traveled from town to town, performing for crowds and collecting stories. The road eventually led to adventures far more exciting than any tale {they} could tell.',
    'A gifted performer, {name} grew tired of the stage and sought real adventures to inspire new material.',
  ],
  'Guild Artisan': [
    '{name} was a respected member of a crafting guild, but wanderlust and a desire to find rare materials drew {them} away from the workshop.',
    'After mastering {their} craft, {name} set out to find legendary materials and techniques lost to time.',
  ],
  Hermit: [
    '{name} spent years in solitary contemplation, living apart from civilization. A revelation during meditation compelled {them} to return to the world.',
    'After a long period of isolation, {name} emerged with a secret discovery that demanded action.',
  ],
  Outlander: [
    '{name} grew up far from civilization, raised by the wilds. Curiosity about the wider world eventually drew {them} toward settled lands and adventure.',
    'A wanderer of the untamed wilderness, {name} was driven from {their} homeland by an encroaching threat.',
  ],
  Sailor: [
    '{name} spent years at sea, weathering storms and battling pirates. When {their} ship was lost, {they} washed ashore and found a new calling on land.',
    'A seasoned sailor, {name} left the maritime life after a harrowing voyage that changed {their} outlook forever.',
  ],
};

/** Generate a short backstory template based on background/race/class. */
export function generateBackstory(background: string, race: string, className: string): string {
  const templates = BACKSTORY_TEMPLATES[background] ?? BACKSTORY_TEMPLATES.Soldier;
  const template = pickRandom(templates);

  // Simple pronoun replacement (use "their/them/they" for simplicity)
  return template
    .replace(/\{name\}/g, `this ${race} ${className}`)
    .replace(/\{their\}/g, 'their')
    .replace(/\{them\}/g, 'them')
    .replace(/\{they\}/g, 'they')
    .replace(/\{themselves\}/g, 'themselves');
}

const BACKGROUND_GOLD: Record<string, number> = {
  Acolyte: 15, Criminal: 15, 'Folk Hero': 10, Noble: 25, Sage: 10, Soldier: 10,
  Charlatan: 15, Entertainer: 15, 'Guild Artisan': 15, Hermit: 5, Outlander: 10, Sailor: 10,
};

/** Generate starting gold based on selected background defaults. */
export function generateStartingTreasure(background: string): string {
  const gold = BACKGROUND_GOLD[background] ?? 10;
  return `${gold} gp`;
}

export const BACKGROUND_ALLIES: Record<string, { faction: string; allies: string }> = {
  Acolyte: {
    faction: 'Temple of the Dawn',
    allies: 'The priests and acolytes of my temple are my spiritual family. They took me in when I had nothing and taught me the ways of the divine. I can count on them for shelter and guidance.',
  },
  Criminal: {
    faction: 'The Shadow Network',
    allies: 'I still have contacts in the criminal underworld. A fence who can move stolen goods, an informant in the city watch, and a safecracker who owes me a favor.',
  },
  'Folk Hero': {
    faction: 'The Common Folk',
    allies: 'The people of my home village remember what I did for them. Farmers, millers, and tradespeople who would shelter me and share what little they have.',
  },
  Noble: {
    faction: 'House of the Silver Crown',
    allies: 'My noble family still holds influence in the region. A loyal retainer manages our estate, and distant cousins serve in courts across the land.',
  },
  Sage: {
    faction: 'The Arcane Academy',
    allies: 'Fellow scholars at the academy correspond with me regularly. The head librarian grants me access to restricted texts, and a colleague researches parallel questions.',
  },
  Soldier: {
    faction: 'The Iron Company',
    allies: 'My old military company remembers me. The quartermaster saves surplus supplies, and my former sergeant would answer a call to arms without hesitation.',
  },
  Charlatan: {
    faction: 'The Gilded Masks',
    allies: 'A loose network of con artists who share marks and cover stories. We watch each other\'s backs — mostly because we know too much about each other.',
  },
  Entertainer: {
    faction: 'The Wandering Troupe',
    allies: 'My former traveling troupe still performs across the region. They offer shelter, news from distant towns, and a warm audience for my latest tales.',
  },
  'Guild Artisan': {
    faction: 'The Artisan\'s Guild',
    allies: 'My guild provides a network of fellow crafters across many cities. The guild hall offers lodging, tools, and introductions to local merchants.',
  },
  Hermit: {
    faction: 'The Seekers of Truth',
    allies: 'A small circle of fellow hermits and mystics who share discoveries through coded letters left at forest shrines. We rarely meet face to face.',
  },
  Outlander: {
    faction: 'The Wilder Clans',
    allies: 'My tribe roams the frontier lands. Hunters, trackers, and elders who know every trail and watering hole. They would welcome me back without question.',
  },
  Sailor: {
    faction: 'The Salted Brotherhood',
    allies: 'Fellow sailors from my years at sea. A first mate who runs a tavern by the docks, a navigator who charts private routes, and a captain who still owes me wages.',
  },
};

