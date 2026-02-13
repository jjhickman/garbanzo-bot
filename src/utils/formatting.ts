/**
 * WhatsApp text formatting helpers
 *
 * WhatsApp uses its own markdown-like syntax:
 *   *bold*  _italic_  ~strikethrough~  ```monospace```
 */

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
