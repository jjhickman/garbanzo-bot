/**
 * Translate the bot-wide WhatsApp-style formatting vocabulary into Matrix
 * org.matrix.custom.html while also producing the required plain body.
 *
 * The delimiter pairing rules intentionally mirror telegram/markdown.ts:
 * whitespace and word-boundary guards avoid false-pairing arithmetic,
 * snake_case identifiers, URLs, and adjacent delimiter runs.
 */

const WORD_BOUNDARY_GUARD = '(?<![A-Za-z0-9_])';
const WORD_BOUNDARY_GUARD_AFTER = '(?![A-Za-z0-9_])';

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

export interface MatrixFormattedText {
  body: string;
  formattedBody: string;
}

export interface MatrixMessageContent extends Record<string, unknown> {
  msgtype: 'm.text';
  body: string;
  format: 'org.matrix.custom.html';
  formatted_body: string;
  'm.relates_to'?: {
    'm.in_reply_to': { event_id: string };
  };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function stripMatrixReplyFallback(text: string): string {
  return text
    .replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, '')
    .replace(/^(?:> ?.*\n)+\n?/, '')
    .trimStart();
}

export function toMatrixFormattedText(text: string): MatrixFormattedText {
  let body = '';
  let formattedBody = '';
  let lastIndex = 0;

  for (const match of text.matchAll(ENTITY_PATTERN)) {
    const index = match.index ?? 0;
    const plain = text.slice(lastIndex, index);
    body += plain;
    formattedBody += escapeHtml(plain);

    const [, codeBlock, inlineCode, bold, italic, strike] = match;
    if (codeBlock !== undefined) {
      body += codeBlock;
      formattedBody += `<pre><code>${escapeHtml(codeBlock)}</code></pre>`;
    } else if (inlineCode !== undefined) {
      body += inlineCode;
      formattedBody += `<code>${escapeHtml(inlineCode)}</code>`;
    } else if (bold !== undefined) {
      body += bold;
      formattedBody += `<strong>${escapeHtml(bold)}</strong>`;
    } else if (italic !== undefined) {
      body += italic;
      formattedBody += `<em>${escapeHtml(italic)}</em>`;
    } else if (strike !== undefined) {
      body += strike;
      formattedBody += `<del>${escapeHtml(strike)}</del>`;
    }

    lastIndex = index + match[0].length;
  }

  const tail = text.slice(lastIndex);
  body += tail;
  formattedBody += escapeHtml(tail);

  return { body, formattedBody };
}

function buildMxReplyFallback(roomId: string, eventId: string): string {
  const href = `https://matrix.to/#/${encodeURIComponent(roomId)}/${encodeURIComponent(eventId)}`;
  return `<mx-reply><blockquote><a href="${href}">In reply to</a></blockquote></mx-reply>`;
}

export function toMatrixMessageContent(
  roomId: string,
  text: string,
  replyEventId?: string,
): MatrixMessageContent {
  const formatted = toMatrixFormattedText(text);
  const formattedBody = replyEventId
    ? `${buildMxReplyFallback(roomId, replyEventId)}${formatted.formattedBody}`
    : formatted.formattedBody;

  return {
    msgtype: 'm.text',
    body: formatted.body,
    format: 'org.matrix.custom.html',
    formatted_body: formattedBody,
    ...(replyEventId ? { 'm.relates_to': { 'm.in_reply_to': { event_id: replyEventId } } } : {}),
  };
}
