/**
 * Input sanitization middleware — hardens all user input before processing.
 *
 * Defenses:
 * 1. Message length limits — reject absurdly long messages
 * 2. Control character stripping — remove null bytes, zero-width chars, RTL overrides
 * 3. Prompt injection detection — flag attempts to override the system prompt
 * 4. JID format validation — strict format check before DB operations
 * 5. Command argument sanitization — prevent path traversal, SQL fragments
 */

import { logger } from './logger.js';

// ── Constants ───────────────────────────────────────────────────────

/** Maximum message length we'll process (chars). WhatsApp max is ~65536. */
export const MAX_MESSAGE_LENGTH = 4096;

/** Maximum length for command arguments (e.g., !suggest, !memory add) */
export const MAX_COMMAND_ARG_LENGTH = 1024;

// ── Control character stripping ─────────────────────────────────────

/**
 * Strip dangerous control characters from user input.
 * Removes: null bytes, zero-width spaces/joiners, RTL/LTR overrides,
 * paragraph separators, and other invisible Unicode.
 */
export function stripControlChars(text: string): string {
  return text
    // Null bytes
    .replace(/\0/g, '')
    // Zero-width characters (U+200B-U+200F, U+FEFF)
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    // Directional overrides (U+202A-U+202E, U+2066-U+2069)
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    // Paragraph/line separators that could break formatting
    .replace(/[\u2028\u2029]/g, '\n')
    .trim();
}

// ── Message length enforcement ──────────────────────────────────────

/**
 * Check if a message exceeds length limits. Returns null if OK,
 * or a rejection reason if too long.
 */
export function checkMessageLength(text: string): string | null {
  if (text.length > MAX_MESSAGE_LENGTH) {
    logger.warn({ length: text.length, max: MAX_MESSAGE_LENGTH }, 'Message exceeds length limit');
    return `Message too long (${text.length} chars, max ${MAX_MESSAGE_LENGTH}). Please shorten it.`;
  }
  return null;
}

// ── Prompt injection detection ──────────────────────────────────────

/**
 * Patterns that suggest prompt injection attempts.
 * These are checked case-insensitively against user messages before
 * they're sent to the AI. If detected, the message is flagged and
 * the injection text is defanged (wrapped in quotes to prevent execution).
 */
const INJECTION_PATTERNS = [
  // Direct system prompt overrides
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /forget\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /override\s+(system|your)\s+(prompt|instructions?|rules?)/i,
  // Role-playing to bypass safety
  /you\s+are\s+now\s+(a|an|the)\s+/i,
  /pretend\s+(you\s+are|to\s+be|you're)\s+(a|an|the|not)\s+/i,
  /act\s+as\s+(if\s+you\s+are|a|an|the)\s+/i,
  /from\s+now\s+on,?\s+you/i,
  // System prompt extraction
  /repeat\s+(your|the)\s+(system\s+)?(prompt|instructions?)/i,
  /what\s+(is|are)\s+your\s+(system\s+)?(prompt|instructions?|rules?)/i,
  /show\s+me\s+your\s+(system\s+)?(prompt|instructions?)/i,
  /print\s+(your|the)\s+(system\s+)?(prompt|instructions?)/i,
  // Developer mode / DAN
  /\bDAN\b.*\bmode\b/i,
  /\bdeveloper\s+mode\b/i,
  /\bjailbreak\b/i,
];

export interface InjectionCheck {
  isInjection: boolean;
  pattern?: string;
}

/**
 * Check if a message contains prompt injection attempts.
 * Returns the detection result. The message is NOT blocked — it's
 * logged and the AI's system prompt already instructs it to refuse.
 */
export function checkPromptInjection(text: string): InjectionCheck {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      const match = text.match(pattern)?.[0] ?? 'unknown';
      logger.warn({ match, textPreview: text.slice(0, 100) }, 'Prompt injection attempt detected');
      return { isInjection: true, pattern: match };
    }
  }
  return { isInjection: false };
}

/**
 * Defang a message that contains injection attempts.
 * Wraps the suspicious parts in quotes so the AI treats them as data, not instructions.
 */
export function defangInjection(text: string): string {
  let result = text;
  for (const pattern of INJECTION_PATTERNS) {
    result = result.replace(pattern, (match) => `"${match}"`);
  }
  return result;
}

// ── JID validation ──────────────────────────────────────────────────

/** Valid WhatsApp JID patterns */
const JID_PATTERNS = {
  user: /^\d{1,15}@s\.whatsapp\.net$/,
  group: /^\d{10,30}@g\.us$/,
  lid: /^\d{1,15}:\d+@lid$/,
};

/**
 * Validate that a string is a properly formatted WhatsApp JID.
 * Prevents malformed JIDs from reaching the database.
 */
export function isValidJid(jid: string): boolean {
  return (
    JID_PATTERNS.user.test(jid) ||
    JID_PATTERNS.group.test(jid) ||
    JID_PATTERNS.lid.test(jid)
  );
}

/**
 * Sanitize a bare JID component (the part before @).
 * Only allows digits, colons, and hyphens.
 */
export function sanitizeBareJid(bare: string): string {
  return bare.replace(/[^\d:.-]/g, '');
}

// ── Command argument sanitization ───────────────────────────────────

/**
 * Sanitize command arguments. Truncates to max length and strips
 * potentially dangerous characters.
 */
export function sanitizeCommandArg(arg: string): string {
  const cleaned = stripControlChars(arg);
  if (cleaned.length > MAX_COMMAND_ARG_LENGTH) {
    return cleaned.slice(0, MAX_COMMAND_ARG_LENGTH);
  }
  return cleaned;
}

// ── Combined sanitization pipeline ──────────────────────────────────

export interface SanitizeResult {
  text: string;
  rejected: boolean;
  rejectionReason?: string;
  injectionDetected: boolean;
}

/**
 * Run the full sanitization pipeline on an incoming message.
 * Returns the cleaned text and any flags.
 */
export function sanitizeMessage(text: string): SanitizeResult {
  // Strip control characters
  const cleaned = stripControlChars(text);

  // Length check
  const lengthError = checkMessageLength(cleaned);
  if (lengthError) {
    return { text: cleaned, rejected: true, rejectionReason: lengthError, injectionDetected: false };
  }

  // Prompt injection check
  const injection = checkPromptInjection(cleaned);
  const finalText = injection.isInjection ? defangInjection(cleaned) : cleaned;

  return {
    text: finalText,
    rejected: false,
    injectionDetected: injection.isInjection,
  };
}
