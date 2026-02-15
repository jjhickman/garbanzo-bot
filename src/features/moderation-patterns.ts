/**
 * Moderation patterns — regex rules, category maps, and type definitions
 * for content moderation.
 *
 * Extracted from moderation.ts for maintainability. Pure data, no
 * external dependencies.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface ModerationFlag {
  /** What rule was potentially violated */
  reason: string;
  /** Severity: 'warning' for borderline, 'alert' for clear violation */
  severity: 'warning' | 'alert';
  /** Source of the flag: 'regex' for pattern match, 'openai' for API */
  source: 'regex' | 'openai';
}

// ── Category mapping ────────────────────────────────────────────────
// Map OpenAI moderation categories to human-readable reasons and severity.
// We skip categories that don't align with community rules (e.g. "self-harm"
// is still flagged but as a warning so the owner can check in supportively).

interface CategoryConfig {
  reason: string;
  severity: 'warning' | 'alert';
}

export const CATEGORY_MAP: Record<string, CategoryConfig> = {
  'hate': { reason: 'Hate speech (AI-detected)', severity: 'alert' },
  'hate/threatening': { reason: 'Hate speech with threats (AI-detected)', severity: 'alert' },
  'harassment': { reason: 'Harassment (AI-detected)', severity: 'alert' },
  'harassment/threatening': { reason: 'Harassment with threats (AI-detected)', severity: 'alert' },
  'sexual': { reason: 'Sexual content (AI-detected)', severity: 'warning' },
  'sexual/minors': { reason: 'Sexual content involving minors (AI-detected)', severity: 'alert' },
  'violence': { reason: 'Violence (AI-detected)', severity: 'warning' },
  'violence/graphic': { reason: 'Graphic violence (AI-detected)', severity: 'alert' },
  'self-harm': { reason: 'Self-harm mention (AI-detected)', severity: 'warning' },
  'self-harm/intent': { reason: 'Self-harm intent (AI-detected)', severity: 'alert' },
  'self-harm/instructions': { reason: 'Self-harm instructions (AI-detected)', severity: 'alert' },
};

// Score thresholds — only flag when the model is fairly confident.
// This avoids false positives on borderline content.
export const SCORE_THRESHOLD_ALERT = 0.7;
export const SCORE_THRESHOLD_WARNING = 0.5;

// ── Pattern-based detection ──────────────────────────────────────────
// These catch obvious violations without any API calls.
// Intentionally conservative — better to miss edge cases than false-flag.

interface ModerationRule {
  name: string;
  severity: 'warning' | 'alert';
  patterns: RegExp[];
}

export const RULES: ModerationRule[] = [
  {
    name: 'Hate speech / slurs',
    severity: 'alert',
    patterns: [
      // Racial slurs
      /\bn[i1]g{2,}[e3]r/i,
      /\bk[i1]ke\b/i,
      /\bsp[i1]c\b/i,
      /\bch[i1]nk\b/i,
      /\bwetback\b/i,
      /\bcoon\b/i,
      // Anti-LGBTQ slurs
      /\bf[a4]g{2,}[o0]t/i,
      /\btr[a4]nn[yi1e]/i,
      /\bdyke\b/i,
      // Gendered slurs (targeted, not casual)
      /\bkill\s+(yourself|urself|all\s+\w+)\b/i,
    ],
  },
  {
    name: 'Threats / violence',
    severity: 'alert',
    patterns: [
      /\bi('?ll|will|gonna|going\s+to)\s+(kill|murder|shoot|stab|beat)\s+\w+/i,
      /\byou('re|\s+are)\s+(dead|gonna\s+die)\b/i,
      /\b(kill|murder|shoot|stab)\s+(you|him|her|them|someone|somebody|anybody|anyone|everybody|everyone)\b/i,
      /\bdox{1,2}(ing|ed)?\b/i,
      /\bswat{1,2}(ing|ed|t?ed)?\b/i,
    ],
  },
  {
    name: 'Spam / self-promotion',
    severity: 'warning',
    patterns: [
      // Crypto/investment spam
      /\b(buy|invest|free)\s+(bitcoin|btc|crypto|nft|token)\b/i,
      /\b(guaranteed|passive)\s+(income|returns|profit)\b/i,
      /\b(dm|message)\s+me\s+(for|to)\s+(earn|make\s+money)\b/i,
      // Repeated link dumping (3+ URLs)
      /https?:\/\/\S+.*https?:\/\/\S+.*https?:\/\/\S+/i,
    ],
  },
  {
    name: 'Personal info sharing',
    severity: 'warning',
    patterns: [
      // SSN pattern
      /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/,
      // Phone numbers being shared about others (not self)
      /\b(his|her|their)\s+(number|phone|cell)\s+is\b/i,
      /\b(lives|address)\s+(at|is)\s+\d+/i,
    ],
  },
];
