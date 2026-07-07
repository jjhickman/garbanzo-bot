import type { MessagingPlatform } from '../core/messaging-platform.js';

type MarkerRule = {
  readonly from: string;
  readonly to: string;
};

type Segment = {
  readonly kind: 'protected' | 'text';
  readonly value: string;
};

const CODE_SPAN_PATTERN = /```[\s\S]{0,4000}?```|`[^`\n]{0,1000}`/y;
const URL_PROTOCOL_PATTERN = /^https?:\/\//;
const URL_TRAILING_PUNCTUATION = /[.,;:!?]/;
const WORD_CHAR_PATTERN = /\w/;
const MAX_URL_BODY_LENGTH = 2048;

const WHATSAPP_TO_DISCORD: readonly MarkerRule[] = [
  { from: '*', to: '**' },
  { from: '_', to: '*' },
  { from: '~', to: '~~' },
];

const DISCORD_TO_WHATSAPP: readonly MarkerRule[] = [
  { from: '**', to: '*' },
  { from: '~~', to: '~' },
  { from: '__', to: '' },
  { from: '*', to: '_' },
];

/*
 * Bridge formatting table:
 * - WhatsApp -> Discord: *bold* -> **bold**, _italic_ -> *italic*,
 *   ~strike~ -> ~~strike~~, inline/triple-backtick code passes through.
 * - Discord -> WhatsApp: **bold** -> *bold*, *italic* -> _italic_,
 *   _italic_ stays unchanged, ~~strike~~ -> ~strike~, __underline__ drops
 *   markers because WhatsApp has no underline, code passes through.
 * - Same platform, Slack, Teams, or any unsupported pair returns text unchanged.
 *
 * Input is tokenized into an ordered array of segments before any formatting rules
 * run: code spans and URLs become 'protected' segments carried through verbatim;
 * everything else becomes a 'text' segment. The marker-translation scanner only ever
 * runs over 'text' segments, and segments are joined back in order at the end. There
 * is no in-band sentinel/placeholder step, so user text can never collide with (and
 * corrupt) the protection mechanism. Rules are applied by a bounded scanner with
 * longest markers first. Repeated cross-platform calls are not required to be
 * idempotent; same-platform calls are identity.
 */
export function translateFormatting(
  text: string,
  from: MessagingPlatform,
  to: MessagingPlatform,
): string {
  if (from === to) return text;

  const rules = selectRules(from, to);
  if (!rules) return text;

  return tokenize(text)
    .map((segment) =>
      segment.kind === 'protected' ? segment.value : translateSegment(segment.value, rules, undefined, 0).text,
    )
    .join('');
}

function selectRules(
  from: MessagingPlatform,
  to: MessagingPlatform,
): readonly MarkerRule[] | null {
  if (from === 'whatsapp' && to === 'discord') return WHATSAPP_TO_DISCORD;
  if (from === 'discord' && to === 'whatsapp') return DISCORD_TO_WHATSAPP;
  return null;
}

function tokenize(text: string): Segment[] {
  const segments: Segment[] = [];
  let buffer = '';
  let position = 0;

  const flushBuffer = () => {
    if (buffer.length > 0) {
      segments.push({ kind: 'text', value: buffer });
      buffer = '';
    }
  };

  while (position < text.length) {
    const codeSpan = matchCodeSpanAt(text, position);
    if (codeSpan !== null) {
      flushBuffer();
      segments.push({ kind: 'protected', value: codeSpan });
      position += codeSpan.length;
      continue;
    }

    const url = matchUrlAt(text, position);
    if (url !== null) {
      flushBuffer();
      segments.push({ kind: 'protected', value: url });
      position += url.length;
      continue;
    }

    buffer += text[position];
    position += 1;
  }

  flushBuffer();
  return segments;
}

function matchCodeSpanAt(text: string, position: number): string | null {
  CODE_SPAN_PATTERN.lastIndex = position;
  const match = CODE_SPAN_PATTERN.exec(text);
  return match && match.index === position ? match[0] : null;
}

function matchUrlAt(text: string, position: number): string | null {
  const previousChar = text[position - 1];
  if (previousChar !== undefined && WORD_CHAR_PATTERN.test(previousChar)) return null;

  const protocolMatch = URL_PROTOCOL_PATTERN.exec(text.slice(position));
  if (!protocolMatch) return null;

  const bodyStart = position + protocolMatch[0].length;
  const bodyLimit = bodyStart + MAX_URL_BODY_LENGTH;
  let depth = 0;
  let end = bodyStart;

  while (end < text.length && end < bodyLimit) {
    const char = text[end];
    if (char === undefined || /\s/.test(char) || char === '<' || char === '>') break;

    if (char === '(') {
      depth += 1;
      end += 1;
      continue;
    }

    if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
      end += 1;
      continue;
    }

    end += 1;
  }

  while (end > bodyStart && URL_TRAILING_PUNCTUATION.test(text[end - 1] ?? '')) {
    end -= 1;
  }

  return end > bodyStart ? text.slice(position, end) : null;
}

function translateSegment(
  text: string,
  rules: readonly MarkerRule[],
  stopMarker: string | undefined,
  depth: number,
): { text: string; position: number; closed: boolean } {
  let output = '';
  let position = 0;

  while (position < text.length) {
    if (stopMarker && text.startsWith(stopMarker, position)) {
      return { text: output, position: position + stopMarker.length, closed: true };
    }

    const rule = rules.find((candidate) => text.startsWith(candidate.from, position));
    if (!rule || depth > 12) {
      output += text[position] ?? '';
      position += 1;
      continue;
    }

    const innerStart = position + rule.from.length;
    const inner = translateSegment(text.slice(innerStart), rules, rule.from, depth + 1);

    if (!inner.closed || inner.text.length === 0) {
      output += rule.from;
      position = innerStart;
      continue;
    }

    output += `${rule.to}${inner.text}${rule.to}`;
    position = innerStart + inner.position;
  }

  return { text: output, position, closed: false };
}
