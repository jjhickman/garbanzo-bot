/**
 * Telegram MarkdownV2 escaping + translation.
 *
 * FORMATTING DECISION (see also src/ai/persona.ts buildFormattingInstruction):
 * the AI model is instructed to emit the SAME WhatsApp-style markdown the
 * rest of the codebase already teaches it (*bold*, _italic_, ~strike~,
 * `code`/```code```) rather than Telegram-specific syntax. This module is
 * the ONLY place that understands MarkdownV2's escaping rules — it
 * translates those WhatsApp-style markers into valid MarkdownV2 entities
 * and escapes every other character. This keeps one formatting vocabulary
 * across all prompt variants and centralizes the fiddly escaping logic
 * (plan risk R1) in a single tested module.
 *
 * Telegram MarkdownV2 spec (https://core.telegram.org/bots/api#markdownv2-style):
 * outside of recognized entities, these characters MUST be escaped with a
 * preceding backslash:
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 * A literal backslash is escaped too, defensively, even though Telegram's
 * docs don't list it explicitly as a "must escape" character — leaving one
 * unescaped risks accidentally escaping whatever character follows it.
 * Inside `code`/```pre``` entities, only backtick and backslash are
 * escaped (Telegram treats the rest of the content verbatim).
 *
 * NESTING: this implementation does NOT support nested entities (e.g. bold
 * containing italic). Content inside a recognized entity is escaped
 * literally rather than recursively re-parsed for further entities — a
 * deliberate v1 simplification. A delimiter character nested inside another
 * entity renders as literal (escaped) text, not a second nested entity.
 *
 * FALSE-PAIRING GUARD (T2 review, F3): a naive "find the next matching
 * delimiter" scan false-pairs unrelated `*`/`_`/`~` occurrences that were
 * never meant as formatting — e.g. 'a * b * c' (arithmetic) bolding ' b ',
 * or 'other_var' pairing across an unrelated 'snake_case' underscore
 * earlier in the sentence. Two conditions must BOTH hold for a delimiter
 * pair to be treated as formatting (otherwise every character in the pair
 * falls through to plain literal escaping):
 *   1. Whitespace rule (WhatsApp's own rule): the opening delimiter must
 *      not be followed by whitespace, and the closing delimiter must not be
 *      preceded by whitespace.
 *   2. Word-boundary rule: the character immediately before the opening
 *      delimiter (if any) and the character immediately after the closing
 *      delimiter (if any) must not be a word character ([A-Za-z0-9_]) —
 *      this is what stops identifier-style text ('snake_case',
 *      'some_page_here' inside a URL) from false-pairing across underscores
 *      that were never intended as a matching pair. Punctuation, other
 *      delimiter characters, whitespace, and string boundaries all satisfy
 *      this rule trivially.
 */

const MDV2_ESCAPE_CHARS = new Set([
  '_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!', '\\',
]);

/** Escape every MarkdownV2 special character in `text` for literal display. */
export function escapeMarkdownV2(text: string): string {
  let out = '';
  for (const ch of text) {
    out += MDV2_ESCAPE_CHARS.has(ch) ? `\\${ch}` : ch;
  }
  return out;
}

/** Inside `code`/```pre``` entities, only backtick and backslash need escaping. */
function escapeCodeContent(text: string): string {
  return text.replace(/[`\\]/g, (ch) => `\\${ch}`);
}

// Order matters: code blocks and inline code are matched before bold/italic/
// strike so a delimiter char inside a code span is never mistaken for
// formatting. Entity content excludes its own delimiter and newlines (except
// triple-backtick code blocks, which may span lines). The bold/italic/strike
// alternatives additionally require: content starts/ends with a non-
// whitespace char (`\S`), and the char immediately outside each delimiter —
// via lookaround, so it isn't consumed — is not a word char (see the
// FALSE-PAIRING GUARD doc comment above).
const WORD_BOUNDARY_GUARD = '(?<![A-Za-z0-9_])';
const WORD_BOUNDARY_GUARD_AFTER = '(?![A-Za-z0-9_])';
/**
 * Build a bold/italic/strike alternative for delimiter `d`: content's first
 * and last characters must be neither whitespace NOR the delimiter itself
 * (`[^\s${d}]`, not the more permissive `\S`, which would let e.g. the
 * second `*` of `**not bold**` count as a valid single-char content edge).
 */
function entityAlternative(delimiter: string): string {
  const d = `\\${delimiter}`;
  const edge = `[^\\s${d}]`;
  const middle = `[^${d}\\n]*`;
  return `${WORD_BOUNDARY_GUARD}${d}(${edge}(?:${middle}${edge})?)${d}${WORD_BOUNDARY_GUARD_AFTER}`;
}
const ENTITY_PATTERN = new RegExp(
  [
    '```([\\s\\S]*?)```',
    '`([^`\\n]+)`',
    entityAlternative('*'),
    entityAlternative('_'),
    entityAlternative('~'),
  ].join('|'),
  'g',
);

/**
 * Translate WhatsApp-style markdown into valid Telegram MarkdownV2, escaping
 * every character outside a recognized entity. Malformed/unmatched
 * delimiters (a lone `*`, an unclosed backtick, etc.) safely fall through to
 * plain-text escaping instead of forming a broken entity.
 */
export function toTelegramMarkdownV2(text: string): string {
  let out = '';
  let lastIndex = 0;

  for (const match of text.matchAll(ENTITY_PATTERN)) {
    const index = match.index ?? 0;
    out += escapeMarkdownV2(text.slice(lastIndex, index));

    const [, codeBlock, inlineCode, bold, italic, strike] = match;
    if (codeBlock !== undefined) {
      out += '```' + escapeCodeContent(codeBlock) + '```';
    } else if (inlineCode !== undefined) {
      out += '`' + escapeCodeContent(inlineCode) + '`';
    } else if (bold !== undefined) {
      out += '*' + escapeMarkdownV2(bold) + '*';
    } else if (italic !== undefined) {
      out += '_' + escapeMarkdownV2(italic) + '_';
    } else if (strike !== undefined) {
      out += '~' + escapeMarkdownV2(strike) + '~';
    }

    lastIndex = index + match[0].length;
  }

  out += escapeMarkdownV2(text.slice(lastIndex));
  return out;
}
