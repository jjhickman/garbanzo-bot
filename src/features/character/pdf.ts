/**
 * PDF field mapping and pdf-lib filling logic for the WotC 5e character sheet.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { logger } from '../../middleware/logger.js';
import { PROJECT_ROOT } from '../../utils/config.js';
import type { AbilityName } from './srd-data.js';
import { ALL_SKILLS, SKILL_ABILITIES } from './srd-data.js';
import { abilityModifier, formatModifier } from './abilities.js';
import type { CharacterData } from './class-race-data.js';
import { CLASS_HIT_DIE } from './class-race-data.js';

const TEMPLATE_PATH = resolve(PROJECT_ROOT, 'templates', '5e-character-sheet.pdf');

// ── PDF Field Mappings ──────────────────────────────────────────────

const SAVE_CHECKBOXES: Record<AbilityName, string> = {
  str: 'Check Box 11', dex: 'Check Box 18', con: 'Check Box 19',
  int: 'Check Box 20', wis: 'Check Box 21', cha: 'Check Box 22',
};

const SKILL_CHECKBOXES: Record<string, string> = {
  Acrobatics: 'Check Box 23', 'Animal Handling': 'Check Box 24', Arcana: 'Check Box 25',
  Athletics: 'Check Box 26', Deception: 'Check Box 27', History: 'Check Box 28',
  Insight: 'Check Box 29', Intimidation: 'Check Box 30', Investigation: 'Check Box 31',
  Medicine: 'Check Box 32', Nature: 'Check Box 33', Perception: 'Check Box 34',
  Performance: 'Check Box 35', Persuasion: 'Check Box 36', Religion: 'Check Box 37',
  'Sleight of Hand': 'Check Box 38', Stealth: 'Check Box 39', Survival: 'Check Box 40',
};

// Note: Some PDF field names have trailing spaces — these MUST be preserved
const SKILL_FIELDS: Record<string, string> = {
  Acrobatics: 'Acrobatics', 'Animal Handling': 'Animal', Arcana: 'Arcana',
  Athletics: 'Athletics', Deception: 'Deception ', History: 'History ',
  Insight: 'Insight', Intimidation: 'Intimidation', Investigation: 'Investigation ',
  Medicine: 'Medicine', Nature: 'Nature', Perception: 'Perception ',
  Performance: 'Performance', Persuasion: 'Persuasion', Religion: 'Religion',
  'Sleight of Hand': 'SleightofHand', Stealth: 'Stealth ', Survival: 'Survival',
};

interface PDFResult {
  pdfBytes: Uint8Array;
  emptyFields: string[];
}

// ── PDF Generation ──────────────────────────────────────────────────

/** Fill the WotC 5e character sheet template and return PDF bytes + validation info */
export async function generateCharacterPDF(char: CharacterData): Promise<PDFResult> {
  const templateBytes = readFileSync(TEMPLATE_PATH);
  const doc = await PDFDocument.load(templateBytes);
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  // Track every field we attempt to set, for post-fill validation
  const fieldLog: Array<{ name: string; value: string; fontSize?: number; ok: boolean }> = [];

  // The WotC template has no /DA (default appearance) entries, but its
  // built-in appearance streams handle font/size for most fields.
  // Only call defaultUpdateAppearances + setFontSize on fields that
  // need custom small text — otherwise the template's own rendering is used.
  const setText = (fieldName: string, value: string, fontSize?: number) => {
    try {
      const field = form.getTextField(fieldName);
      if (fontSize) {
        field.defaultUpdateAppearances(font);
        field.setFontSize(fontSize);
      }
      field.setText(value);
      fieldLog.push({ name: fieldName, value, fontSize, ok: true });
    } catch (err) {
      logger.warn({ fieldName, fontSize, err }, 'PDF setText failed (pass 1)');
      fieldLog.push({ name: fieldName, value, fontSize, ok: false });
    }
  };

  const setCheck = (fieldName: string) => {
    try {
      const field = form.getCheckBox(fieldName);
      field.check();
    } catch (err) {
      logger.warn({ fieldName, err }, 'PDF setCheck failed');
    }
  };

  // ── Header fields ───────────────────────────────────────────
  setText('CharacterName', char.name);
  setText('ClassLevel', `${char.class} ${char.level}`);
  setText('Background', char.background);
  setText('PlayerName', 'Garbanzo');
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
  setText('ProfBonus', formatModifier(char.profBonus));
  setText('AC', String(char.ac));
  setText('Initiative', formatModifier(abilityModifier(char.abilities.dex)));
  setText('Speed', String(char.speed));
  setText('HPMax', String(char.hp));
  setText('HPCurrent', String(char.hp));
  setText('HDTotal', String(char.level));
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
  setText('Equipment', char.equipment, 7);
  setText('Features and Traits', char.racialTraits, 5.5);  // Page 1: narrow box (165x370px)
  setText('ProficienciesLang', char.proficienciesAndLanguages, 7);

  // ── Personality ─────────────────────────────────────────────
  setText('PersonalityTraits ', char.personalityTrait);  // Trailing space
  setText('Ideals', char.ideal);
  setText('Bonds', char.bond);
  setText('Flaws', char.flaw);

  // ── Page 2 — Appearance & Backstory ─────────────────────────
  setText('CharacterName 2', char.name);
  setText('Age', char.age);
  setText('Height', char.height);
  setText('Weight', char.weight);
  setText('Eyes', char.eyes);
  setText('Skin', char.skin);
  setText('Hair', char.hair);
  setText('Backstory', char.backstory, 8);
  setText('Allies', char.allies, 7);
  setText('FactionName', char.factionName, 8);
  setText('Feat+Traits', char.classFeatures, 8);  // Page 2: class features
  setText('Treasure', char.treasure, 8);

  // ── Page 3 — Spellcasting (if applicable) ───────────────────
  if (char.isSpellcaster) {
    setText('Spellcasting Class 2', char.class);
    setText('SpellcastingAbility 2', char.spellcastingAbility);
    setText('SpellSaveDC  2', String(char.spellSaveDC));   // Double space in field name
    setText('SpellAtkBonus 2', formatModifier(char.spellAttackBonus));

    // Cantrips — fields: Spells 1014, 1016-1022 (8 slots)
    const cantripFields = ['Spells 1014', 'Spells 1016', 'Spells 1017', 'Spells 1018',
      'Spells 1019', 'Spells 1020', 'Spells 1021', 'Spells 1022'];
    for (let i = 0; i < char.cantrips.length && i < cantripFields.length; i++) {
      setText(cantripFields[i], char.cantrips[i]);
    }

    // Level 1 spells — fields: Spells 1015, 1023-1033 (12 slots)
    // Preparation checkboxes: Check Box 251 (first), 309, 3010-3019 (remaining)
    const level1Fields = ['Spells 1015', 'Spells 1023', 'Spells 1024', 'Spells 1025',
      'Spells 1026', 'Spells 1027', 'Spells 1028', 'Spells 1029',
      'Spells 1030', 'Spells 1031', 'Spells 1032', 'Spells 1033'];
    const level1PrepBoxes = ['Check Box 251', 'Check Box 309', 'Check Box 3010',
      'Check Box 3011', 'Check Box 3012', 'Check Box 3013', 'Check Box 3014',
      'Check Box 3015', 'Check Box 3016', 'Check Box 3017', 'Check Box 3018',
      'Check Box 3019'];
    for (let i = 0; i < char.level1Spells.length && i < level1Fields.length; i++) {
      setText(level1Fields[i], char.level1Spells[i]);
      if (level1PrepBoxes[i]) setCheck(level1PrepBoxes[i]);  // Mark as prepared
    }

    // Spell slots — SlotsTotal/Remaining 19-27 for levels 1-9
    const slotFieldIds = [19, 20, 21, 22, 23, 24, 25, 26, 27];
    for (let i = 0; i < 9; i++) {
      if (char.spellSlots[i] > 0) {
        setText(`SlotsTotal ${slotFieldIds[i]}`, String(char.spellSlots[i]));
        setText(`SlotsRemaining ${slotFieldIds[i]}`, String(char.spellSlots[i]));
      }
    }
  }

  // ── Post-fill validation + retry ──────────────────────────────
  const failed = fieldLog.filter((f) => !f.ok);
  if (failed.length > 0) {
    logger.warn({ failedCount: failed.length, fields: failed.map((f) => f.name) },
      'PDF field validation: retrying failed fields with defaultUpdateAppearances');

    for (const entry of failed) {
      try {
        const field = form.getTextField(entry.name);
        field.defaultUpdateAppearances(font);
        if (entry.fontSize) field.setFontSize(entry.fontSize);
        field.setText(entry.value);
        entry.ok = true;
        logger.info({ fieldName: entry.name }, 'PDF field retry succeeded');
      } catch (err) {
        logger.error({ fieldName: entry.name, err }, 'PDF field retry FAILED — field will be empty');
      }
    }
  }

  // Read back all text fields to verify they were actually set
  const emptyFields: string[] = [];
  for (const entry of fieldLog) {
    try {
      const field = form.getTextField(entry.name);
      const readBack = field.getText();
      if (!readBack && entry.value) {
        emptyFields.push(entry.name);
      }
    } catch {
      // Field might not exist — already logged above
    }
  }

  if (emptyFields.length > 0) {
    logger.error({ emptyFields, count: emptyFields.length },
      'PDF validation: fields are empty after fill — character sheet is incomplete');
  }

  const totalFilled = fieldLog.length - emptyFields.length;
  logger.info({ totalFields: fieldLog.length, filled: totalFilled, empty: emptyFields.length },
    'PDF field fill summary');

  // Flatten the form so it displays correctly on all viewers
  form.flatten();

  const pdfBytes = await doc.save();
  return { pdfBytes, emptyFields };
}
