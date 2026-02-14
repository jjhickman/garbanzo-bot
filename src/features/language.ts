/**
 * Multi-language support — detect message language and instruct AI to respond in kind.
 *
 * Uses simple heuristics to detect non-English messages. If detected,
 * adds an instruction to the AI context to respond in that language.
 *
 * Supported detection:
 * - Spanish, Portuguese, French, Mandarin/Chinese, Japanese, Korean,
 *   Arabic, Hindi, Russian, Italian, German
 *
 * This is a best-effort heuristic — Claude's own multilingual ability
 * does the heavy lifting. We just need to tell it to match the language.
 */

import { logger } from '../middleware/logger.js';

interface LanguageHint {
  /** ISO 639-1 code */
  code: string;
  /** Human-readable name */
  name: string;
}

// Character-range detectors for non-Latin scripts
const SCRIPT_PATTERNS: Array<{ pattern: RegExp; code: string; name: string }> = [
  // Japanese must be checked BEFORE Chinese — hiragana/katakana are unique to Japanese,
  // but kanji overlap with Chinese characters. If we see any kana, it's Japanese.
  { pattern: /[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff]/, code: 'ja', name: 'Japanese' },
  { pattern: /[\u4e00-\u9fff]/, code: 'zh', name: 'Chinese' },
  { pattern: /[\uac00-\ud7af\u1100-\u11ff]/, code: 'ko', name: 'Korean' },
  { pattern: /[\u0600-\u06ff\u0750-\u077f]/, code: 'ar', name: 'Arabic' },
  { pattern: /[\u0900-\u097f]/, code: 'hi', name: 'Hindi' },
  { pattern: /[\u0400-\u04ff]/, code: 'ru', name: 'Russian' },
];

// Common word patterns for Latin-script languages (checked after script detection fails)
const WORD_PATTERNS: Array<{ pattern: RegExp; code: string; name: string }> = [
  { pattern: /\b(hola|gracias|bueno|también|cómo|qué|está|por favor|dónde|tengo|puede|quiero)\b/i, code: 'es', name: 'Spanish' },
  { pattern: /\b(obrigad[oa]|você|também|bom|como|está|porque|por favor|onde|tenho|pode|quero)\b/i, code: 'pt', name: 'Portuguese' },
  { pattern: /\b(bonjour|merci|aussi|comment|bien|s'il vous plaît|où|pourquoi|je suis|oui|non|très)\b/i, code: 'fr', name: 'French' },
  { pattern: /\b(buongiorno|grazie|anche|come|bene|per favore|dove|perché|sono|sì)\b/i, code: 'it', name: 'Italian' },
  { pattern: /\b(danke|auch|wie|bitte|wo|warum|ich bin|ja|nein|sehr|gut)\b/i, code: 'de', name: 'German' },
];

/**
 * Detect the probable language of a message.
 * Returns null if the message appears to be English or detection is uncertain.
 */
export function detectLanguage(text: string): LanguageHint | null {
  if (!text || text.length < 5) return null;

  // Check non-Latin scripts first (high confidence)
  for (const { pattern, code, name } of SCRIPT_PATTERNS) {
    // Need at least 2 characters from the script to avoid false positives from emoji etc.
    const matches = text.match(new RegExp(pattern.source, 'g'));
    if (matches && matches.length >= 2) {
      logger.debug({ language: name, code }, 'Non-English language detected');
      return { code, name };
    }
  }

  // Check Latin-script languages via common words
  // Require at least 2 matching words to avoid false positives
  for (const { pattern, code, name } of WORD_PATTERNS) {
    const matches = text.match(new RegExp(pattern.source, 'gi'));
    if (matches && matches.length >= 2) {
      logger.debug({ language: name, code, matchCount: matches.length }, 'Non-English language detected');
      return { code, name };
    }
  }

  return null;
}

/**
 * Build a language instruction to append to the AI system prompt.
 * Returns empty string if the message is English.
 */
export function buildLanguageInstruction(text: string): string {
  const lang = detectLanguage(text);
  if (!lang) return '';

  return `\nIMPORTANT: The user's message appears to be in ${lang.name}. Respond in ${lang.name} to match their language. If you're unsure of the language, respond in English.`;
}
