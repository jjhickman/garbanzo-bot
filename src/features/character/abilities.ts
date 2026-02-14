/**
 * Ability score rolling, modifiers, and racial bonuses.
 */

import type { AbilityName } from './srd-data.js';
import { CLASS_PRIMARY_ABILITIES } from './srd-data.js';

// ── Types ───────────────────────────────────────────────────────────

export interface AbilityScores {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

// ── Stat Generation ─────────────────────────────────────────────────

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
