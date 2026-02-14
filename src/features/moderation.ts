import { getGroupName } from '../bot/groups.js';
import { bold } from '../utils/formatting.js';
import { phoneFromJid } from '../utils/jid.js';

/**
 * Content moderation — scans messages for community rule violations
 * and flags them to the owner via DM. Never auto-acts.
 *
 * Community rules (from PERSONA.md):
 * - No spam, self-promotion, or unsolicited links
 * - Be respectful to all members
 * - No sharing personal information about others
 * - No NSFW content
 * - Zero tolerance for targeted harm, hate speech, or harassment
 *
 * Note: Casual profanity and adult topics are fine.
 * This only flags serious violations.
 */

export interface ModerationFlag {
  /** What rule was potentially violated */
  reason: string;
  /** Severity: 'warning' for borderline, 'alert' for clear violation */
  severity: 'warning' | 'alert';
}

// ── Pattern-based detection ──────────────────────────────────────────
// These catch obvious violations without any API calls.
// Intentionally conservative — better to miss edge cases than false-flag.

interface ModerationRule {
  name: string;
  severity: 'warning' | 'alert';
  patterns: RegExp[];
}

const RULES: ModerationRule[] = [
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

// ── Public API ───────────────────────────────────────────────────────

/**
 * Check a message for community rule violations.
 * Returns a ModerationFlag if a violation is detected, null otherwise.
 */
export function checkMessage(text: string): ModerationFlag | null {
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(text))) {
      return { reason: rule.name, severity: rule.severity };
    }
  }
  return null;
}

/**
 * Format a moderation alert for the owner's DM.
 */
export function formatModerationAlert(
  flag: ModerationFlag,
  text: string,
  senderJid: string,
  groupJid: string,
): string {
  const groupName = getGroupName(groupJid);
  const sender = phoneFromJid(senderJid);
  const severity = flag.severity === 'alert' ? '🚨 ALERT' : '⚠️ Warning';
  const preview = text.length > 200 ? text.slice(0, 200) + '...' : text;

  return [
    `${severity}: ${bold(flag.reason)}`,
    '',
    `${bold('Group')}: ${groupName}`,
    `${bold('Sender')}: ${sender}`,
    `${bold('Message')}: ${preview}`,
    '',
    `_Review this message — no action has been taken._`,
  ].join('\n');
}
