/**
 * Introduction message classifier — signal-based detection of new member
 * introductions in the Introductions group.
 *
 * Extracted from introductions.ts for maintainability. Pure logic, no
 * external dependencies.
 */

// ── Constants ───────────────────────────────────────────────────────

/** Minimum character length to consider a message an introduction */
const MIN_INTRO_LENGTH = 40;

// ── Intro detection ─────────────────────────────────────────────────

/**
 * Determine if a message looks like a new member introduction.
 *
 * Heuristic: must be long enough AND contain intro-like signals
 * (first-person language, greeting + personal info, etc.).
 * This prevents casual group chat from triggering intro responses.
 */
export function looksLikeIntroduction(text: string): boolean {
  const trimmed = text.trim();

  // Too short to be an intro
  if (trimmed.length < MIN_INTRO_LENGTH) return false;

  const lower = trimmed.toLowerCase();

  // ── Negative filters: messages that are clearly NOT intros ──

  // Bot mentions / commands
  if (lower.startsWith('@garbanzo') || lower.startsWith('@bot')) return false;
  if (/^!/.test(trimmed)) return false;

  // Messages containing @mentions are likely conversation, not intros
  if (/@\d+/.test(trimmed) || /@\S+/.test(trimmed) && trimmed.includes('@')) {
    // Allow if message ALSO has strong intro signals (someone might @mention
    // while introducing themselves, but this is rare)
    if (!hasStrongIntroSignals(lower)) return false;
  }

  // Responses to someone else's intro — second-person welcoming language
  if (isWelcomeResponse(lower)) return false;

  // Mostly a question — intros are declarative, not interrogative
  const sentences = trimmed.split(/[.!?\n]+/).filter((s) => s.trim().length > 0);
  const questionCount = sentences.filter((s) => s.trim().endsWith('?') || /\?/.test(s)).length;
  if (sentences.length > 0 && questionCount / sentences.length > 0.6) return false;

  // ── Positive filter: must contain intro-like content ──
  return hasIntroSignals(lower);
}

/**
 * Detect messages that are responses to someone else's introduction,
 * not introductions themselves. These use second-person language
 * ("welcome!", "glad you're here", "you'll love it") rather than
 * first-person self-description.
 */
function isWelcomeResponse(lower: string): boolean {
  const patterns = [
    /^welcome\b/,                        // "Welcome! So glad..."
    /\bwelcome to the/,                  // "welcome to the group"
    /\bglad (?:you(?:'re| are)|to have you)/, // "glad you're here"
    /\byou(?:'ll| will) (?:love|like|enjoy)/, // "you'll love it here"
    /\bgreat to have you/,              // "great to have you"
    /\bgood to have you/,              // "good to have you"
    /\bnice to have you/,              // "nice to have you"
    /\bhappy to have you/,             // "happy to have you"
    /\bwe(?:'re| are) glad/,           // "we're glad you joined"
  ];
  return patterns.some((p) => p.test(lower));
}

/** Strong intro signals — high confidence this is an introduction */
function hasStrongIntroSignals(lower: string): boolean {
  const strongPatterns = [
    /\bi'?m\s+\w+.*\d{2,}/,           // "I'm Sarah, 28" — name + age
    /my name(?:'s| is)\s/,              // "my name is..."
    /just (?:moved|relocated|came)/,    // "just moved to Boston"
    /new (?:here|to the|to this|member)/, // "new here", "new to the group"
    /nice to meet/,                      // "nice to meet everyone"
    /looking forward to/,                // "looking forward to meetups"
    /introduce myself/,                  // "let me introduce myself"
    /moved (?:to|from|here)/,           // "moved to Cambridge"
  ];
  return strongPatterns.some((p) => p.test(lower));
}

/** General intro signals — at least one must be present */
function hasIntroSignals(lower: string): boolean {
  // Strong signals are sufficient on their own
  if (hasStrongIntroSignals(lower)) return true;

  // Weaker signals: need the message to feel intro-like overall.
  // Require at least TWO of these weaker signals.
  let weakSignalCount = 0;

  // First-person self-description
  if (/\bi'?m\b/.test(lower) || /\bi am\b/.test(lower)) weakSignalCount++;

  // Greeting opener
  if (/^(?:hey|hi|hello|what'?s up|sup|yo|greetings|howdy)\b/.test(lower)) weakSignalCount++;

  // Mentions personal interests/hobbies
  if (/\b(?:i (?:like|love|enjoy|play|do)|my hobbies|into\s+\w+|fan of|interested in)\b/.test(lower)) weakSignalCount++;

  // Mentions location/origin
  if (/\b(?:from|live in|living in|based in|moved|originally)\b/.test(lower)) weakSignalCount++;

  // Mentions age or personal details
  if (/\b\d{2}\s*(?:yo|y\/o|years? old|,|\.)\b/.test(lower) || /\bage\s*\d/.test(lower)) weakSignalCount++;

  // Mentions job/school/work
  if (/\b(?:work(?:ing)?\s+(?:at|in|as)|study|student|grad school|college|job)\b/.test(lower)) weakSignalCount++;

  // Mentions meeting people / community
  if (/\b(?:meet (?:people|new|everyone)|join|found this group|excited to)\b/.test(lower)) weakSignalCount++;

  return weakSignalCount >= 2;
}

// ── Intro-specific AI prompt addendum ───────────────────────────────

export const INTRO_SYSTEM_ADDENDUM = [
  '',
  '--- SPECIAL CONTEXT ---',
  '',
  'A new member just posted their introduction. Your job is to welcome them warmly.',
  'Read what they shared about themselves and respond with:',
  '- A genuine, warm welcome to the community',
  '- A comment or question about something specific they mentioned (shows you actually read it)',
  '- Optionally, a suggestion of which groups they might enjoy based on their interests',
  '',
  'Keep it to 2-4 sentences. Do NOT use a template — make each response feel personal.',
  'Do NOT ask multiple questions — at most one, and only if it flows naturally.',
  'Do NOT list all the groups. Only mention 1-2 that directly match what they shared.',
].join('\n');
