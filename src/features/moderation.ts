import OpenAI from 'openai';
import { getGroupName } from '../bot/groups.js';
import { bold } from '../utils/formatting.js';
import { phoneFromJid } from '../utils/jid.js';
import { config } from '../utils/config.js';
import { logger } from '../middleware/logger.js';
import { getStrikeCount, getRepeatOffenders, type StrikeSummary } from '../utils/db.js';

/**
 * Content moderation — scans messages for community rule violations
 * and flags them to the owner via DM. Never auto-acts.
 *
 * Two-layer approach:
 * 1. Regex patterns — fast, zero-latency check for obvious slurs/threats
 * 2. OpenAI Moderation API — catches nuanced violations (harassment,
 *    self-harm, sexual content, etc.) that patterns miss
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
  /** Source of the flag: 'regex' for pattern match, 'openai' for API */
  source: 'regex' | 'openai';
}

// ── OpenAI client (lazy-initialized) ────────────────────────────────

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI | null {
  if (openaiClient) return openaiClient;
  if (!config.OPENAI_API_KEY) return null;
  openaiClient = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  return openaiClient;
}

// ── Category mapping ────────────────────────────────────────────────
// Map OpenAI moderation categories to human-readable reasons and severity.
// We skip categories that don't align with community rules (e.g. "self-harm"
// is still flagged but as a warning so the owner can check in supportively).

interface CategoryConfig {
  reason: string;
  severity: 'warning' | 'alert';
}

const CATEGORY_MAP: Record<string, CategoryConfig> = {
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
const SCORE_THRESHOLD_ALERT = 0.7;
const SCORE_THRESHOLD_WARNING = 0.5;

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
 * Check a message for community rule violations using regex patterns.
 * Synchronous, zero-latency — runs first as a fast pre-filter.
 */
export function checkMessageRegex(text: string): ModerationFlag | null {
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(text))) {
      return { reason: rule.name, severity: rule.severity, source: 'regex' };
    }
  }
  return null;
}

/**
 * Check a message using the OpenAI Moderation API.
 * Returns a ModerationFlag if a violation is detected, null otherwise.
 * Returns null (no-op) if OPENAI_API_KEY is not configured.
 */
export async function checkMessageOpenAI(text: string): Promise<ModerationFlag | null> {
  const client = getOpenAIClient();
  if (!client) return null;

  // Skip very short messages — not worth the API call
  if (text.trim().length < 5) return null;

  try {
    const response = await client.moderations.create({
      model: 'omni-moderation-latest',
      input: text,
    });

    const result = response.results[0];
    if (!result || !result.flagged) return null;

    // Find the highest-scoring flagged category
    const scores = result.category_scores;
    let highestCategory: string | null = null;
    let highestScore = 0;

    for (const [category, score] of Object.entries(scores)) {
      if (score > highestScore) {
        highestScore = score;
        highestCategory = category;
      }
    }

    if (!highestCategory) return null;

    // Apply score thresholds to reduce false positives
    const categoryConfig = CATEGORY_MAP[highestCategory];
    if (!categoryConfig) {
      // Unknown category — flag as warning if score is high enough
      if (highestScore >= SCORE_THRESHOLD_WARNING) {
        return {
          reason: `Moderation flag: ${highestCategory} (AI-detected)`,
          severity: 'warning',
          source: 'openai',
        };
      }
      return null;
    }

    const threshold = categoryConfig.severity === 'alert'
      ? SCORE_THRESHOLD_ALERT
      : SCORE_THRESHOLD_WARNING;

    if (highestScore < threshold) return null;

    return {
      reason: categoryConfig.reason,
      severity: categoryConfig.severity,
      source: 'openai',
    };
  } catch (err) {
    logger.error({ err }, 'OpenAI moderation API call failed — falling back to regex only');
    return null;
  }
}

/**
 * Full moderation check — runs regex first (instant), then OpenAI API.
 * Returns the first flag found (regex takes priority since it's instant).
 * If both layers pass, returns null.
 */
export async function checkMessage(text: string): Promise<ModerationFlag | null> {
  // Layer 1: Regex (instant, catches obvious violations)
  const regexFlag = checkMessageRegex(text);
  if (regexFlag) return regexFlag;

  // Layer 2: OpenAI Moderation API (catches nuanced violations)
  return await checkMessageOpenAI(text);
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
  const sourceLabel = flag.source === 'openai' ? ' [AI]' : ' [Pattern]';
  const preview = text.length > 200 ? text.slice(0, 200) + '...' : text;
  const strikeCount = getStrikeCount(senderJid);

  const lines = [
    `${severity}: ${bold(flag.reason)}${sourceLabel}`,
    '',
    `${bold('Group')}: ${groupName}`,
    `${bold('Sender')}: ${sender}`,
    `${bold('Strikes')}: ${strikeCount}`,
    `${bold('Message')}: ${preview}`,
  ];

  if (strikeCount >= STRIKE_THRESHOLD) {
    lines.push('');
    lines.push(`🔇 *User soft-muted for ${SOFT_MUTE_MINUTES} minutes* (bot will ignore their messages)`);
    lines.push(`_This is strike ${strikeCount} — consider manual action._`);
  } else {
    lines.push('');
    lines.push(`_Review this message — no action has been taken._`);
  }

  return lines.join('\n');
}

// ── Soft-mute system ────────────────────────────────────────────────
// When a user accumulates 3+ strikes, the bot ignores their messages
// for a cooldown period and DMs them explaining why.

const STRIKE_THRESHOLD = 3;
const SOFT_MUTE_MINUTES = 30;

/** In-memory mute tracker: senderJid → mute expiry timestamp (ms) */
const mutedUsers = new Map<string, number>();

/**
 * Apply a soft-mute to a user after a moderation flag.
 * Checks their strike count and mutes them if at threshold.
 * Returns a DM message to send to the user, or null if no mute applied.
 */
export function applyStrikeAndMute(senderJid: string): { muted: boolean; dmMessage: string | null } {
  const strikes = getStrikeCount(senderJid);

  if (strikes >= STRIKE_THRESHOLD) {
    const expiresAt = Date.now() + SOFT_MUTE_MINUTES * 60 * 1000;
    mutedUsers.set(senderJid, expiresAt);
    logger.warn({ senderJid, strikes, muteMinutes: SOFT_MUTE_MINUTES }, 'User soft-muted');

    const dmMessage = [
      `🫘 Hey — your recent messages have been flagged ${strikes} time${strikes > 1 ? 's' : ''} by our community safety system.`,
      '',
      `To keep things chill, I'm taking a ${SOFT_MUTE_MINUTES}-minute break from responding to your messages.`,
      '',
      'If you think this is a mistake, reach out to the group admins directly.',
      '',
      `_This is an automated message. Admins have been notified._`,
    ].join('\n');

    return { muted: true, dmMessage };
  }

  return { muted: false, dmMessage: null };
}

/**
 * Check if a user is currently soft-muted.
 * Returns true if the bot should ignore their messages.
 */
export function isSoftMuted(senderJid: string): boolean {
  const expiresAt = mutedUsers.get(senderJid);
  if (!expiresAt) return false;

  if (Date.now() >= expiresAt) {
    mutedUsers.delete(senderJid);
    logger.info({ senderJid }, 'Soft-mute expired');
    return false;
  }

  return true;
}

// ── !strikes command ────────────────────────────────────────────────

/**
 * Format the !strikes report for the owner.
 * Shows all users with 2+ strikes, sorted by count.
 */
export function formatStrikesReport(): string {
  const offenders = getRepeatOffenders(2);

  if (offenders.length === 0) {
    return '🫘 No repeat offenders found. Community is looking clean.';
  }

  const lines: string[] = [
    `🫘 ${bold('Strike Report')}`,
    '',
  ];

  for (const o of offenders) {
    const muted = mutedUsers.has(o.sender) ? ' 🔇' : '';
    const lastFlag = new Date(o.last_flag * 1000).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    lines.push(`• ${bold(o.sender)} — ${o.strike_count} strikes${muted}`);
    lines.push(`  Last: ${lastFlag}`);
    lines.push(`  Reasons: ${o.reasons}`);
    lines.push('');
  }

  const muteCount = offenders.filter((o: StrikeSummary) => mutedUsers.has(o.sender)).length;
  if (muteCount > 0) {
    lines.push(`_${muteCount} user${muteCount > 1 ? 's' : ''} currently soft-muted._`);
  }

  return lines.join('\n');
}
