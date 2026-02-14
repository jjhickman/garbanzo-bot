import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════════════════
// Character sheet generation tests
// ═══════════════════════════════════════════════════════════════════

describe('Character — roll4d6DropLowest', async () => {
  const { roll4d6DropLowest } = await import('../src/features/character.js');

  it('produces a value between 3 and 18', () => {
    // Run many times to test range
    for (let i = 0; i < 100; i++) {
      const val = roll4d6DropLowest();
      expect(val).toBeGreaterThanOrEqual(3);
      expect(val).toBeLessThanOrEqual(18);
    }
  });
});

describe('Character — abilityModifier', async () => {
  const { abilityModifier } = await import('../src/features/character.js');

  it('calculates correct modifiers', () => {
    expect(abilityModifier(1)).toBe(-5);
    expect(abilityModifier(8)).toBe(-1);
    expect(abilityModifier(9)).toBe(-1);
    expect(abilityModifier(10)).toBe(0);
    expect(abilityModifier(11)).toBe(0);
    expect(abilityModifier(12)).toBe(1);
    expect(abilityModifier(14)).toBe(2);
    expect(abilityModifier(16)).toBe(3);
    expect(abilityModifier(18)).toBe(4);
    expect(abilityModifier(20)).toBe(5);
  });
});

describe('Character — formatModifier', async () => {
  const { formatModifier } = await import('../src/features/character.js');

  it('formats positive modifiers with +', () => {
    expect(formatModifier(0)).toBe('+0');
    expect(formatModifier(1)).toBe('+1');
    expect(formatModifier(3)).toBe('+3');
  });

  it('formats negative modifiers with -', () => {
    expect(formatModifier(-1)).toBe('-1');
    expect(formatModifier(-3)).toBe('-3');
  });
});

describe('Character — generateAbilityScores', async () => {
  const { generateAbilityScores } = await import('../src/features/character.js');

  it('returns all six ability scores', () => {
    const scores = generateAbilityScores('wizard');
    expect(scores).toHaveProperty('str');
    expect(scores).toHaveProperty('dex');
    expect(scores).toHaveProperty('con');
    expect(scores).toHaveProperty('int');
    expect(scores).toHaveProperty('wis');
    expect(scores).toHaveProperty('cha');
  });

  it('all scores are in the valid 4d6-drop-lowest range (3-18)', () => {
    for (let i = 0; i < 50; i++) {
      const scores = generateAbilityScores('fighter');
      for (const val of Object.values(scores)) {
        expect(val).toBeGreaterThanOrEqual(3);
        expect(val).toBeLessThanOrEqual(18);
      }
    }
  });

  it('assigns highest scores to class primary abilities', () => {
    // Wizard: INT > CON > DEX should be the priority
    // Run many times — statistically, INT should be the highest on average
    let intHighest = 0;
    const runs = 200;
    for (let i = 0; i < runs; i++) {
      const scores = generateAbilityScores('wizard');
      if (scores.int >= scores.str && scores.int >= scores.cha && scores.int >= scores.wis) {
        intHighest++;
      }
    }
    // INT should be the highest score most of the time (it gets the first/highest roll)
    expect(intHighest / runs).toBeGreaterThan(0.5);
  });
});

describe('Character — applyRacialBonuses', async () => {
  const char = await import('../src/features/character.js');
  const applyRacialBonuses = char.applyRacialBonuses;
  type AbilityScores = import('../src/features/character.js').AbilityScores;

  const baseScores: AbilityScores = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };

  it('applies human +1 to all abilities', () => {
    const result = applyRacialBonuses(baseScores, 'human');
    expect(result.str).toBe(11);
    expect(result.dex).toBe(11);
    expect(result.con).toBe(11);
    expect(result.int).toBe(11);
    expect(result.wis).toBe(11);
    expect(result.cha).toBe(11);
  });

  it('applies elf +2 DEX', () => {
    const result = applyRacialBonuses(baseScores, 'elf');
    expect(result.dex).toBe(12);
    expect(result.str).toBe(10); // unchanged
  });

  it('applies dwarf +2 CON', () => {
    const result = applyRacialBonuses(baseScores, 'dwarf');
    expect(result.con).toBe(12);
  });

  it('applies dragonborn +2 STR, +1 CHA', () => {
    const result = applyRacialBonuses(baseScores, 'dragonborn');
    expect(result.str).toBe(12);
    expect(result.cha).toBe(11);
  });

  it('applies tiefling +1 INT, +2 CHA', () => {
    const result = applyRacialBonuses(baseScores, 'tiefling');
    expect(result.int).toBe(11);
    expect(result.cha).toBe(12);
  });

  it('applies half-elf +2 CHA and +1 to two other abilities', () => {
    const result = applyRacialBonuses(baseScores, 'half-elf');
    expect(result.cha).toBe(12);
    // Two other abilities should be 11 (not CHA)
    const bonused = [result.str, result.dex, result.con, result.int, result.wis]
      .filter((v) => v === 11);
    expect(bonused).toHaveLength(2);
  });

  it('does not mutate the original scores object', () => {
    const original = { ...baseScores };
    applyRacialBonuses(baseScores, 'human');
    expect(baseScores).toEqual(original);
  });
});

describe('Character — parseCharacterArgs', async () => {
  const { parseCharacterArgs } = await import('../src/features/character.js');

  it('parses race and class together', () => {
    const result = parseCharacterArgs('elf wizard');
    expect(result.race).toBe('elf');
    expect(result.class).toBe('wizard');
  });

  it('parses race only', () => {
    const result = parseCharacterArgs('dwarf');
    expect(result.race).toBe('dwarf');
    expect(result.class).toBeUndefined();
  });

  it('parses class only', () => {
    const result = parseCharacterArgs('rogue');
    expect(result.race).toBeUndefined();
    expect(result.class).toBe('rogue');
  });

  it('handles empty input', () => {
    const result = parseCharacterArgs('');
    expect(result.race).toBeUndefined();
    expect(result.class).toBeUndefined();
  });

  it('handles "random" keyword', () => {
    const result = parseCharacterArgs('random');
    expect(result.race).toBeUndefined();
    expect(result.class).toBeUndefined();
  });

  it('handles aliases', () => {
    expect(parseCharacterArgs('barb').class).toBe('barbarian');
    expect(parseCharacterArgs('pally').class).toBe('paladin');
    expect(parseCharacterArgs('wiz').class).toBe('wizard');
    expect(parseCharacterArgs('mage').class).toBe('wizard');
    expect(parseCharacterArgs('thief').class).toBe('rogue');
    expect(parseCharacterArgs('hobbit').race).toBe('halfling');
  });

  it('is case-insensitive', () => {
    expect(parseCharacterArgs('ELF WIZARD').race).toBe('elf');
    expect(parseCharacterArgs('ELF WIZARD').class).toBe('wizard');
  });

  it('handles hyphenated races', () => {
    expect(parseCharacterArgs('half-elf').race).toBe('half-elf');
    expect(parseCharacterArgs('halfelf').race).toBe('half-elf');
    expect(parseCharacterArgs('half-orc').race).toBe('half-orc');
    expect(parseCharacterArgs('halforc').race).toBe('half-orc');
  });

  it('ignores unrecognized words', () => {
    const result = parseCharacterArgs('make me an elf wizard please');
    expect(result.race).toBe('elf');
    expect(result.class).toBe('wizard');
  });
});

describe('Character — generateCharacter', async () => {
  const { generateCharacter } = await import('../src/features/character.js');

  it('generates a complete character with all required fields', () => {
    const char = generateCharacter();
    expect(char.name).toBeTruthy();
    expect(char.race).toBeTruthy();
    expect(char.class).toBeTruthy();
    expect(char.level).toBe(1);
    expect(char.background).toBeTruthy();
    expect(char.alignment).toBeTruthy();
    expect(char.hp).toBeGreaterThanOrEqual(1);
    expect(char.ac).toBeGreaterThanOrEqual(10);
    expect(char.speed).toBeGreaterThanOrEqual(25);
    expect(char.profBonus).toBe(2);
    expect(char.saveProficiencies).toHaveLength(2);
    expect(char.skillProficiencies.length).toBeGreaterThanOrEqual(2);
    expect(char.equipment).toBeTruthy();
    expect(char.racialTraits).toBeTruthy();
    expect(char.classFeatures).toBeTruthy();
    expect(char.personalityTrait).toBeTruthy();
    expect(char.ideal).toBeTruthy();
    expect(char.bond).toBeTruthy();
    expect(char.flaw).toBeTruthy();
    // Page 2 fields
    expect(char.age).toBeTruthy();
    expect(char.height).toBeTruthy();
    expect(char.weight).toBeTruthy();
    expect(char.eyes).toBeTruthy();
    expect(char.skin).toBeTruthy();
    expect(char.hair).toBeTruthy();
    expect(char.backstory).toBeTruthy();
    expect(char.treasure).toBeTruthy();
    // Page 3 fields
    expect(typeof char.isSpellcaster).toBe('boolean');
  });

  it('respects specified race', () => {
    const char = generateCharacter('elf');
    expect(char.race).toBe('Elf');
    expect(char.raceIndex).toBe('elf');
  });

  it('respects specified class', () => {
    const char = generateCharacter(undefined, 'wizard');
    expect(char.class).toBe('Wizard');
    expect(char.classIndex).toBe('wizard');
  });

  it('respects both race and class', () => {
    const char = generateCharacter('dwarf', 'fighter');
    expect(char.race).toBe('Dwarf');
    expect(char.class).toBe('Fighter');
  });

  it('falls back to random for invalid race/class', () => {
    const char = generateCharacter('nonsense', 'invalid');
    // Should not crash — picks random instead
    expect(char.name).toBeTruthy();
    expect(char.race).toBeTruthy();
    expect(char.class).toBeTruthy();
  });

  it('barbarian has correct class properties', () => {
    const char = generateCharacter(undefined, 'barbarian');
    expect(char.hitDie).toBe('1d12');
    expect(char.saveProficiencies).toEqual(expect.arrayContaining(['str', 'con']));
  });

  it('wizard has correct class properties', () => {
    const char = generateCharacter(undefined, 'wizard');
    expect(char.hitDie).toBe('1d6');
    expect(char.saveProficiencies).toEqual(expect.arrayContaining(['int', 'wis']));
  });

  it('rogue gets 4 skill proficiencies', () => {
    const char = generateCharacter(undefined, 'rogue');
    expect(char.skillProficiencies).toHaveLength(4);
  });

  it('bard gets 3 skill proficiencies', () => {
    const char = generateCharacter(undefined, 'bard');
    expect(char.skillProficiencies).toHaveLength(3);
  });
});

describe('Character — formatCharacterSummary', async () => {
  const { generateCharacter, formatCharacterSummary } = await import('../src/features/character.js');

  it('produces a WhatsApp-formatted summary', () => {
    const char = generateCharacter('elf', 'wizard');
    const summary = formatCharacterSummary(char);

    expect(summary).toContain(char.name);
    expect(summary).toContain('Elf');
    expect(summary).toContain('Wizard');
    expect(summary).toContain('Level 1');
    expect(summary).toContain('HP:');
    expect(summary).toContain('AC:');
    expect(summary).toContain('STR');
    expect(summary).toContain('DEX');
    expect(summary).toContain('PDF');
  });
});

describe('Character — generateCharacterPDF', async () => {
  const { generateCharacter, generateCharacterPDF } = await import('../src/features/character.js');

  it('generates valid PDF bytes', async () => {
    const char = generateCharacter('human', 'fighter');
    const pdfBytes = await generateCharacterPDF(char);

    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    expect(pdfBytes.length).toBeGreaterThan(10000); // A filled PDF should be substantial

    // Check PDF magic bytes (%PDF)
    const header = String.fromCharCode(pdfBytes[0], pdfBytes[1], pdfBytes[2], pdfBytes[3]);
    expect(header).toBe('%PDF');
  });

  it('generates different PDFs for different characters', async () => {
    const char1 = generateCharacter('elf', 'wizard');
    const char2 = generateCharacter('dwarf', 'barbarian');

    const pdf1 = await generateCharacterPDF(char1);
    const pdf2 = await generateCharacterPDF(char2);

    // Different characters should produce different PDFs
    expect(pdf1.length).not.toBe(pdf2.length);
  });
});

describe('Character — handleCharacter', async () => {
  const { handleCharacter } = await import('../src/features/character.js');

  it('returns help for "help" input', async () => {
    const result = await handleCharacter('help');
    expect(typeof result).toBe('string');
    expect(result as string).toContain('Character Generator');
    expect(result as string).toContain('!character');
  });

  it('returns help for "?" input', async () => {
    const result = await handleCharacter('?');
    expect(typeof result).toBe('string');
    expect(result as string).toContain('Character Generator');
  });

  it('generates a CharacterResult for empty input (full random)', async () => {
    const result = await handleCharacter('');
    expect(typeof result).not.toBe('string');
    const charResult = result as { summary: string; pdfBytes: Uint8Array; fileName: string };
    expect(charResult.summary).toBeTruthy();
    expect(charResult.pdfBytes).toBeInstanceOf(Uint8Array);
    expect(charResult.fileName).toMatch(/\.pdf$/);
  });

  it('generates for specified race and class', async () => {
    const result = await handleCharacter('elf wizard');
    expect(typeof result).not.toBe('string');
    const charResult = result as { summary: string; pdfBytes: Uint8Array; fileName: string };
    expect(charResult.summary).toContain('Elf');
    expect(charResult.summary).toContain('Wizard');
    expect(charResult.fileName).toContain('Elf');
    expect(charResult.fileName).toContain('Wizard');
  });

  it('generates for class-only input', async () => {
    const result = await handleCharacter('rogue');
    expect(typeof result).not.toBe('string');
    const charResult = result as { summary: string; pdfBytes: Uint8Array; fileName: string };
    expect(charResult.summary).toContain('Rogue');
  });
});

// ── Router integration ──────────────────────────────────────────────

describe('Character — feature router integration', async () => {
  const { matchFeature } = await import('../src/features/router.js');

  it('routes !character to character feature', () => {
    expect(matchFeature('!character')?.feature).toBe('character');
  });

  it('routes !char to character feature', () => {
    expect(matchFeature('!char elf wizard')?.feature).toBe('character');
    expect(matchFeature('!char elf wizard')?.query).toBe('elf wizard');
  });

  it('routes !charsheet to character feature', () => {
    expect(matchFeature('!charsheet')?.feature).toBe('character');
  });

  it('routes natural language "create a character" to character feature', () => {
    expect(matchFeature('create a character')?.feature).toBe('character');
    expect(matchFeature('generate a character')?.feature).toBe('character');
    expect(matchFeature('make a character sheet')?.feature).toBe('character');
  });

  it('routes "new character" to character feature', () => {
    expect(matchFeature('new character')?.feature).toBe('character');
  });

  it('does not match unrelated queries as character', () => {
    expect(matchFeature('what is the weather')?.feature).not.toBe('character');
    expect(matchFeature('tell me a joke')).toBeNull();
  });

  // ── Natural language with race/class names (no "character" keyword) ──

  it('routes "make me an elf wizard" to character', () => {
    expect(matchFeature('make me an elf wizard')?.feature).toBe('character');
  });

  it('routes "create a dwarf fighter" to character', () => {
    expect(matchFeature('create a dwarf fighter')?.feature).toBe('character');
  });

  it('routes "roll me up a half-orc barbarian" to character', () => {
    expect(matchFeature('roll me up a half-orc barbarian')?.feature).toBe('character');
  });

  it('routes "generate a tiefling warlock" to character', () => {
    expect(matchFeature('generate a tiefling warlock')?.feature).toBe('character');
  });

  it('routes "build me a human paladin" to character', () => {
    expect(matchFeature('build me a human paladin')?.feature).toBe('character');
  });

  it('routes "make a rogue" (class only) to character', () => {
    expect(matchFeature('make a rogue')?.feature).toBe('character');
  });

  it('routes "create a gnome" (race only) to character', () => {
    expect(matchFeature('create a gnome')?.feature).toBe('character');
  });

  it('routes "I want to play a halfling bard" to character', () => {
    expect(matchFeature('I want to play a halfling bard')?.feature).toBe('character');
  });

  it('routes "I want to be an elf druid" to character', () => {
    expect(matchFeature('I want to be an elf druid')?.feature).toBe('character');
  });

  it('routes "I wanna be a wizard" to character', () => {
    expect(matchFeature('I wanna be a wizard')?.feature).toBe('character');
  });

  it('routes "make me a half-elf ranger" (hyphenated race) to character', () => {
    expect(matchFeature('make me a half-elf ranger')?.feature).toBe('character');
  });

  it('routes "make me a halfelf sorcerer" (no hyphen) to character', () => {
    expect(matchFeature('make me a halfelf sorcerer')?.feature).toBe('character');
  });

  it('routes "create me a cleric" to character', () => {
    expect(matchFeature('create me a cleric')?.feature).toBe('character');
  });

  it('preserves the full query for arg parsing', () => {
    const match = matchFeature('make me an elf wizard');
    expect(match?.feature).toBe('character');
    expect(match?.query).toContain('elf');
    expect(match?.query).toContain('wizard');
  });

  it('does not falsely match casual mentions of races/classes', () => {
    // These should NOT route to character — no creation intent verb
    expect(matchFeature('I love playing wizard in video games')?.feature).not.toBe('character');
    expect(matchFeature('my friend is an elf fan')?.feature).not.toBe('character');
  });
});

// ── Page 2 — Appearance & Backstory ─────────────────────────────────

describe('Character — appearance generation', async () => {
  const { generateCharacter } = await import('../src/features/character.js');

  it('generates age within race-appropriate range for elf', () => {
    const char = generateCharacter('elf', 'wizard');
    const age = parseInt(char.age, 10);
    expect(age).toBeGreaterThanOrEqual(100);
    expect(age).toBeLessThanOrEqual(750);
  });

  it('generates age within race-appropriate range for human', () => {
    const char = generateCharacter('human', 'fighter');
    const age = parseInt(char.age, 10);
    expect(age).toBeGreaterThanOrEqual(18);
    expect(age).toBeLessThanOrEqual(80);
  });

  it('generates age within race-appropriate range for dwarf', () => {
    const char = generateCharacter('dwarf', 'cleric');
    const age = parseInt(char.age, 10);
    expect(age).toBeGreaterThanOrEqual(50);
    expect(age).toBeLessThanOrEqual(350);
  });

  it('generates height in feet/inches format', () => {
    const char = generateCharacter('human', 'fighter');
    expect(char.height).toMatch(/^\d+'\d+"$/);
  });

  it('generates weight with lbs suffix', () => {
    const char = generateCharacter('human', 'fighter');
    expect(char.weight).toMatch(/^\d+ lbs$/);
  });

  it('generates non-empty eye, skin, and hair colors', () => {
    const char = generateCharacter('elf', 'ranger');
    expect(char.eyes.length).toBeGreaterThan(0);
    expect(char.skin.length).toBeGreaterThan(0);
    expect(char.hair.length).toBeGreaterThan(0);
  });

  it('generates a backstory string', () => {
    const char = generateCharacter('human', 'fighter');
    expect(char.backstory.length).toBeGreaterThan(20);
  });

  it('generates treasure with gp', () => {
    const char = generateCharacter('human', 'fighter');
    expect(char.treasure).toMatch(/\d+ gp/);
  });

  it('halfling has appropriate short height', () => {
    const char = generateCharacter('halfling', 'rogue');
    // Halflings are 2'9" to 3'3" — height should start with 2' or 3'
    expect(char.height).toMatch(/^[23]'\d+"$/);
  });
});

// ── Page 3 — Spellcasting ───────────────────────────────────────────

describe('Character — spellcasting', async () => {
  const { generateCharacter } = await import('../src/features/character.js');

  it('wizard is a spellcaster', () => {
    const char = generateCharacter('elf', 'wizard');
    expect(char.isSpellcaster).toBe(true);
    expect(char.spellcastingAbility).toBe('INT');
    expect(char.spellSaveDC).toBeGreaterThanOrEqual(10); // 8 + 2 + mod (min 0)
    expect(char.cantrips.length).toBe(3);
    expect(char.level1Spells.length).toBe(6); // Wizard spellbook
    expect(char.level1Slots).toBe(2);
  });

  it('bard is a spellcaster with CHA', () => {
    const char = generateCharacter('half-elf', 'bard');
    expect(char.isSpellcaster).toBe(true);
    expect(char.spellcastingAbility).toBe('CHA');
    expect(char.cantrips.length).toBe(2);
    expect(char.level1Spells.length).toBe(4);
    expect(char.level1Slots).toBe(2);
  });

  it('cleric is a spellcaster with WIS', () => {
    const char = generateCharacter('dwarf', 'cleric');
    expect(char.isSpellcaster).toBe(true);
    expect(char.spellcastingAbility).toBe('WIS');
    expect(char.cantrips.length).toBe(3);
    expect(char.level1Spells.length).toBeGreaterThanOrEqual(1); // WIS mod + 1
    expect(char.level1Slots).toBe(2);
  });

  it('sorcerer is a spellcaster with CHA', () => {
    const char = generateCharacter('tiefling', 'sorcerer');
    expect(char.isSpellcaster).toBe(true);
    expect(char.spellcastingAbility).toBe('CHA');
    expect(char.cantrips.length).toBe(4);
    expect(char.level1Spells.length).toBe(2);
    expect(char.level1Slots).toBe(2);
  });

  it('warlock is a spellcaster with CHA', () => {
    const char = generateCharacter('tiefling', 'warlock');
    expect(char.isSpellcaster).toBe(true);
    expect(char.spellcastingAbility).toBe('CHA');
    expect(char.cantrips.length).toBe(2);
    expect(char.level1Spells.length).toBe(2);
    expect(char.level1Slots).toBe(1); // Warlock only gets 1 at level 1
  });

  it('druid is a spellcaster with WIS', () => {
    const char = generateCharacter('human', 'druid');
    expect(char.isSpellcaster).toBe(true);
    expect(char.spellcastingAbility).toBe('WIS');
    expect(char.cantrips.length).toBe(2);
    expect(char.level1Spells.length).toBeGreaterThanOrEqual(1);
    expect(char.level1Slots).toBe(2);
  });

  it('barbarian is NOT a spellcaster', () => {
    const char = generateCharacter('half-orc', 'barbarian');
    expect(char.isSpellcaster).toBe(false);
    expect(char.cantrips).toHaveLength(0);
    expect(char.level1Spells).toHaveLength(0);
    expect(char.level1Slots).toBe(0);
  });

  it('fighter is NOT a spellcaster', () => {
    const char = generateCharacter('human', 'fighter');
    expect(char.isSpellcaster).toBe(false);
    expect(char.cantrips).toHaveLength(0);
    expect(char.level1Spells).toHaveLength(0);
  });

  it('rogue is NOT a spellcaster', () => {
    const char = generateCharacter('halfling', 'rogue');
    expect(char.isSpellcaster).toBe(false);
  });

  it('monk is NOT a spellcaster', () => {
    const char = generateCharacter('human', 'monk');
    expect(char.isSpellcaster).toBe(false);
  });

  it('paladin is NOT a spellcaster at level 1', () => {
    const char = generateCharacter('human', 'paladin');
    expect(char.isSpellcaster).toBe(false);
  });

  it('ranger is NOT a spellcaster at level 1', () => {
    const char = generateCharacter('elf', 'ranger');
    expect(char.isSpellcaster).toBe(false);
  });

  it('spell save DC = 8 + profBonus + ability mod', () => {
    const char = generateCharacter('elf', 'wizard');
    if (char.isSpellcaster) {
      // For wizard: ability is INT
      const intMod = Math.floor((char.abilities.int - 10) / 2);
      expect(char.spellSaveDC).toBe(8 + 2 + intMod);
      expect(char.spellAttackBonus).toBe(2 + intMod);
    }
  });

  it('cantrips are unique (no duplicates)', () => {
    for (let i = 0; i < 20; i++) {
      const char = generateCharacter('elf', 'wizard');
      const unique = new Set(char.cantrips);
      expect(unique.size).toBe(char.cantrips.length);
    }
  });

  it('level 1 spells are unique (no duplicates)', () => {
    for (let i = 0; i < 20; i++) {
      const char = generateCharacter('elf', 'wizard');
      const unique = new Set(char.level1Spells);
      expect(unique.size).toBe(char.level1Spells.length);
    }
  });
});
