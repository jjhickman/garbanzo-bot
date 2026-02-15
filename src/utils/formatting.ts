/**
 * WhatsApp text formatting helpers + shared utility types.
 *
 * WhatsApp uses its own markdown-like syntax:
 *   *bold*  _italic_  ~strikethrough~  ```monospace```
 */

// ── Shared utility types ────────────────────────────────────────────

/**
 * Discriminated union for feature handlers that can return different result types.
 * Use this instead of returning `string | SomeOtherType` to make the handler's
 * success/failure explicit.
 *
 * @example
 * ```ts
 * type CharOutput = Result<{ pdf: Buffer; summary: string }, string>;
 * function handleChar(q: string): CharOutput {
 *   if (error) return { ok: false, error: 'Invalid class' };
 *   return { ok: true, value: { pdf, summary } };
 * }
 * ```
 */
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/** Bold text */
export function bold(text: string): string {
  return `*${text}*`;
}

/** Italic text */
export function italic(text: string): string {
  return `_${text}_`;
}

/** Strikethrough text */
export function strike(text: string): string {
  return `~${text}~`;
}

/** Monospace/code text */
export function code(text: string): string {
  return `\`\`\`${text}\`\`\``;
}

/** Truncate text to max length with ellipsis */
export function truncate(text: string, maxLength: number = 4000): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}
