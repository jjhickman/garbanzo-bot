/**
 * Spell slot tables, cantrip/spell lists, spellcasting generation,
 * profBonusForLevel, and calculateHP.
 */

import type { AbilityName } from './srd-data.js';
import { pickRandomN } from './srd-data.js';
import type { AbilityScores } from './abilities.js';
import { abilityModifier } from './abilities.js';

// ── Spellcasting Info ───────────────────────────────────────────────

export interface SpellcastingInfo {
  isSpellcaster: boolean;
  spellcastingAbility: string;
  spellSaveDC: number;
  spellAttackBonus: number;
  cantrips: string[];
  level1Spells: string[];
  spellSlots: number[];  // index 0 = level 1 slots, ..., index 8 = level 9 slots
}

// ── Full Caster Spell Slot Progression ──────────────────────────────
// Each entry: [L1, L2, L3, L4, L5, L6, L7, L8, L9]

const FULL_CASTER_SLOTS: number[][] = [
  /* Lv 1 */  [2, 0, 0, 0, 0, 0, 0, 0, 0],
  /* Lv 2 */  [3, 0, 0, 0, 0, 0, 0, 0, 0],
  /* Lv 3 */  [4, 2, 0, 0, 0, 0, 0, 0, 0],
  /* Lv 4 */  [4, 3, 0, 0, 0, 0, 0, 0, 0],
  /* Lv 5 */  [4, 3, 2, 0, 0, 0, 0, 0, 0],
  /* Lv 6 */  [4, 3, 3, 0, 0, 0, 0, 0, 0],
  /* Lv 7 */  [4, 3, 3, 1, 0, 0, 0, 0, 0],
  /* Lv 8 */  [4, 3, 3, 2, 0, 0, 0, 0, 0],
  /* Lv 9 */  [4, 3, 3, 3, 1, 0, 0, 0, 0],
  /* Lv10 */  [4, 3, 3, 3, 2, 0, 0, 0, 0],
  /* Lv11 */  [4, 3, 3, 3, 2, 1, 0, 0, 0],
  /* Lv12 */  [4, 3, 3, 3, 2, 1, 0, 0, 0],
  /* Lv13 */  [4, 3, 3, 3, 2, 1, 1, 0, 0],
  /* Lv14 */  [4, 3, 3, 3, 2, 1, 1, 0, 0],
  /* Lv15 */  [4, 3, 3, 3, 2, 1, 1, 1, 0],
  /* Lv16 */  [4, 3, 3, 3, 2, 1, 1, 1, 0],
  /* Lv17 */  [4, 3, 3, 3, 2, 1, 1, 1, 1],
  /* Lv18 */  [4, 3, 3, 3, 3, 1, 1, 1, 1],
  /* Lv19 */  [4, 3, 3, 3, 3, 2, 1, 1, 1],
  /* Lv20 */  [4, 3, 3, 3, 3, 2, 2, 1, 1],
];

// ── Warlock Pact Magic Slots ────────────────────────────────────────

const WARLOCK_SLOTS: Array<{ count: number; level: number }> = [
  /* Lv 1 */  { count: 1, level: 1 },
  /* Lv 2 */  { count: 2, level: 1 },
  /* Lv 3 */  { count: 2, level: 2 },
  /* Lv 4 */  { count: 2, level: 2 },
  /* Lv 5 */  { count: 2, level: 3 },
  /* Lv 6 */  { count: 2, level: 3 },
  /* Lv 7 */  { count: 2, level: 4 },
  /* Lv 8 */  { count: 2, level: 4 },
  /* Lv 9 */  { count: 2, level: 5 },
  /* Lv10 */  { count: 2, level: 5 },
  /* Lv11 */  { count: 3, level: 5 },
  /* Lv12 */  { count: 3, level: 5 },
  /* Lv13 */  { count: 3, level: 5 },
  /* Lv14 */  { count: 3, level: 5 },
  /* Lv15 */  { count: 3, level: 5 },
  /* Lv16 */  { count: 3, level: 5 },
  /* Lv17 */  { count: 4, level: 5 },
  /* Lv18 */  { count: 4, level: 5 },
  /* Lv19 */  { count: 4, level: 5 },
  /* Lv20 */  { count: 4, level: 5 },
];

// ── Cantrip Progression by Class ────────────────────────────────────

const CANTRIP_PROGRESSION: Record<string, number[]> = {
  // index = level - 1
  bard:     [2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
  cleric:   [3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
  druid:    [2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
  sorcerer: [4, 4, 4, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6],
  warlock:  [2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
  wizard:   [3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
};

// ── Class Spellcasting Config ───────────────────────────────────────

const CLASS_SPELLCASTING: Record<string, {
  ability: AbilityName;
  cantripCount: number;
  spellsKnown: number;
  slots: number;
} | null> = {
  barbarian: null,
  bard: { ability: 'cha', cantripCount: 2, spellsKnown: 4, slots: 2 },
  cleric: { ability: 'wis', cantripCount: 3, spellsKnown: 0, slots: 2 },  // Cleric prepares, not "known"
  druid: { ability: 'wis', cantripCount: 2, spellsKnown: 0, slots: 2 },   // Druid prepares
  fighter: null,
  monk: null,
  paladin: null,  // No spells at level 1
  ranger: null,   // No spells at level 1
  rogue: null,
  sorcerer: { ability: 'cha', cantripCount: 4, spellsKnown: 2, slots: 2 },
  warlock: { ability: 'cha', cantripCount: 2, spellsKnown: 2, slots: 1 },
  wizard: { ability: 'int', cantripCount: 3, spellsKnown: 6, slots: 2 },  // Spellbook has 6
};

export const ABILITY_DISPLAY: Record<AbilityName, string> = {
  str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA',
};

// ── Cantrips by Class (SRD) ────────────────────────────────────────

const CLASS_CANTRIPS: Record<string, string[]> = {
  bard: ['Blade Ward', 'Dancing Lights', 'Friends', 'Light', 'Mage Hand', 'Mending',
    'Message', 'Minor Illusion', 'Prestidigitation', 'True Strike', 'Vicious Mockery'],
  cleric: ['Guidance', 'Light', 'Mending', 'Resistance', 'Sacred Flame',
    'Spare the Dying', 'Thaumaturgy'],
  druid: ['Druidcraft', 'Guidance', 'Mending', 'Poison Spray', 'Produce Flame',
    'Resistance', 'Shillelagh', 'Thorn Whip'],
  sorcerer: ['Acid Splash', 'Blade Ward', 'Chill Touch', 'Dancing Lights', 'Fire Bolt',
    'Friends', 'Light', 'Mage Hand', 'Mending', 'Message', 'Minor Illusion',
    'Poison Spray', 'Prestidigitation', 'Ray of Frost', 'Shocking Grasp', 'True Strike'],
  warlock: ['Blade Ward', 'Chill Touch', 'Eldritch Blast', 'Friends', 'Mage Hand',
    'Minor Illusion', 'Poison Spray', 'Prestidigitation', 'True Strike'],
  wizard: ['Acid Splash', 'Blade Ward', 'Chill Touch', 'Dancing Lights', 'Fire Bolt',
    'Friends', 'Light', 'Mage Hand', 'Mending', 'Message', 'Minor Illusion',
    'Poison Spray', 'Prestidigitation', 'Ray of Frost', 'Shocking Grasp', 'True Strike'],
};

// ── Level 1 Spells by Class (SRD subset) ────────────────────────────

const CLASS_LEVEL1_SPELLS: Record<string, string[]> = {
  bard: ['Charm Person', 'Cure Wounds', 'Detect Magic', 'Disguise Self', 'Faerie Fire',
    'Feather Fall', 'Healing Word', 'Heroism', 'Identify', 'Silent Image',
    'Sleep', 'Speak with Animals', 'Thunderwave', 'Unseen Servant'],
  cleric: ['Bless', 'Command', 'Cure Wounds', 'Detect Magic', 'Guiding Bolt',
    'Healing Word', 'Inflict Wounds', 'Protection from Evil and Good',
    'Sanctuary', 'Shield of Faith'],
  druid: ['Animal Friendship', 'Charm Person', 'Cure Wounds', 'Detect Magic',
    'Entangle', 'Faerie Fire', 'Fog Cloud', 'Goodberry', 'Healing Word',
    'Jump', 'Speak with Animals', 'Thunderwave'],
  sorcerer: ['Burning Hands', 'Charm Person', 'Chromatic Orb', 'Color Spray',
    'Detect Magic', 'Disguise Self', 'Expeditious Retreat', 'False Life',
    'Fog Cloud', 'Jump', 'Mage Armor', 'Magic Missile', 'Shield', 'Sleep', 'Thunderwave'],
  warlock: ['Armor of Agathys', 'Arms of Hadar', 'Charm Person', 'Comprehend Languages',
    'Expeditious Retreat', 'Hellish Rebuke', 'Hex', 'Illusory Script',
    'Protection from Evil and Good', 'Unseen Servant', 'Witch Bolt'],
  wizard: ['Burning Hands', 'Charm Person', 'Chromatic Orb', 'Color Spray',
    'Comprehend Languages', 'Detect Magic', 'Disguise Self', 'Expeditious Retreat',
    'False Life', 'Feather Fall', 'Find Familiar', 'Fog Cloud', 'Grease',
    'Identify', 'Jump', 'Mage Armor', 'Magic Missile', 'Protection from Evil and Good',
    'Shield', 'Silent Image', 'Sleep', 'Thunderwave', 'Unseen Servant'],
};

// ── Spellcasting Generator ──────────────────────────────────────────

export function generateSpellcasting(classIndex: string, abilities: AbilityScores, level: number, profBonus: number): SpellcastingInfo {
  const spellConfig = CLASS_SPELLCASTING[classIndex];
  const emptySlots = [0, 0, 0, 0, 0, 0, 0, 0, 0];

  if (!spellConfig) {
    return {
      isSpellcaster: false,
      spellcastingAbility: '',
      spellSaveDC: 0,
      spellAttackBonus: 0,
      cantrips: [],
      level1Spells: [],
      spellSlots: emptySlots,
    };
  }

  const abilityMod = abilityModifier(abilities[spellConfig.ability]);

  // Cantrip count scales with level
  const cantripProgression = CANTRIP_PROGRESSION[classIndex];
  const cantripCount = cantripProgression ? cantripProgression[level - 1] : spellConfig.cantripCount;

  // Pick cantrips
  const availableCantrips = CLASS_CANTRIPS[classIndex] ?? [];
  const cantrips = pickRandomN(availableCantrips, Math.min(cantripCount, availableCantrips.length));

  // Pick level 1 spells
  const availableSpells = CLASS_LEVEL1_SPELLS[classIndex] ?? [];
  const spellCount = spellConfig.spellsKnown > 0
    ? spellConfig.spellsKnown
    : Math.max(1, abilityMod + level);  // Prepared: ability mod + level
  const level1Spells = pickRandomN(availableSpells, Math.min(spellCount, availableSpells.length));

  // Spell slots by level
  let spellSlots: number[];
  if (classIndex === 'warlock') {
    // Pact magic: all slots are same level
    const pact = WARLOCK_SLOTS[level - 1];
    spellSlots = emptySlots.map((_, i) => i === pact.level - 1 ? pact.count : 0);
  } else {
    // Full caster slot progression
    spellSlots = FULL_CASTER_SLOTS[level - 1] ?? FULL_CASTER_SLOTS[0];
  }

  return {
    isSpellcaster: true,
    spellcastingAbility: ABILITY_DISPLAY[spellConfig.ability],
    spellSaveDC: 8 + profBonus + abilityMod,
    spellAttackBonus: profBonus + abilityMod,
    cantrips,
    level1Spells,
    spellSlots,
  };
}

// ── Level Utilities ─────────────────────────────────────────────────

/** Calculate proficiency bonus from level */
export function profBonusForLevel(level: number): number {
  return Math.ceil(level / 4) + 1;
}

/** Calculate HP at a given level using average hit die rolls */
export function calculateHP(hitDie: number, conMod: number, level: number): number {
  // Level 1: max hit die + CON mod. Each subsequent level: avg(hitDie) + CON mod
  const avgRoll = Math.floor(hitDie / 2) + 1;
  return hitDie + conMod + (level - 1) * (avgRoll + conMod);
}
