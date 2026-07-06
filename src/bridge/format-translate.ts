import type { MessagingPlatform } from '../core/messaging-platform.js';

type MarkerRule = {
  readonly from: string;
  readonly to: string;
};

const CODE_SPAN_PATTERN = /```[\s\S]{0,4000}?```|`[^`\n]{0,1000}`/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()]{1,2048}/g;
const PLACEHOLDER_PREFIX = '\uE000BRIDGE';
const PLACEHOLDER_SUFFIX = '\uE001';

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
 * Code spans are protected before formatting rules, then URLs are protected so
 * marker-looking URL characters are restored untouched. Rules are applied by a
 * bounded scanner with longest markers first. Repeated cross-platform calls are
 * not required to be idempotent; same-platform calls are identity.
 */
export function translateFormatting(
  text: string,
  from: MessagingPlatform,
  to: MessagingPlatform,
): string {
  if (from === to) return text;

  const rules = selectRules(from, to);
  if (!rules) return text;

  const protectedValues: string[] = [];
  const withoutCode = protect(text, CODE_SPAN_PATTERN, protectedValues);
  const withoutUrls = protect(withoutCode, URL_PATTERN, protectedValues);
  const translated = translateSegment(withoutUrls, rules, undefined, 0).text;

  return restore(translated, protectedValues);
}

function selectRules(
  from: MessagingPlatform,
  to: MessagingPlatform,
): readonly MarkerRule[] | null {
  if (from === 'whatsapp' && to === 'discord') return WHATSAPP_TO_DISCORD;
  if (from === 'discord' && to === 'whatsapp') return DISCORD_TO_WHATSAPP;
  return null;
}

function protect(text: string, pattern: RegExp, protectedValues: string[]): string {
  return text.replace(pattern, (match) => {
    const index = protectedValues.push(match) - 1;
    return `${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_SUFFIX}`;
  });
}

function restore(text: string, protectedValues: readonly string[]): string {
  let restored = text;

  for (const [index, value] of protectedValues.entries()) {
    restored = restored.replaceAll(`${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_SUFFIX}`, value);
  }

  return restored;
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
