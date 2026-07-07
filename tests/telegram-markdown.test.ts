import { describe, expect, it } from 'vitest';

import { escapeMarkdownV2, toTelegramMarkdownV2 } from '../src/platforms/telegram/markdown.js';

describe('escapeMarkdownV2', () => {
  it('escapes every MarkdownV2 special character', () => {
    const special = '_*[]()~`>#+-=|{}.!\\';
    const escaped = escapeMarkdownV2(special);
    for (const ch of special) {
      expect(escaped).toContain(`\\${ch}`);
    }
  });

  it('leaves plain alphanumeric text untouched', () => {
    expect(escapeMarkdownV2('Hello world 123')).toBe('Hello world 123');
  });

  it('leaves emoji and non-ASCII text untouched', () => {
    expect(escapeMarkdownV2('Garbanzo Bean 🫘 café')).toBe('Garbanzo Bean 🫘 café');
  });

  it('escapes a period-heavy sentence', () => {
    expect(escapeMarkdownV2('Hello. This (works) - right?'))
      .toBe('Hello\\. This \\(works\\) \\- right?');
  });

  it('escapes an empty string to an empty string', () => {
    expect(escapeMarkdownV2('')).toBe('');
  });
});

describe('toTelegramMarkdownV2 — entity translation', () => {
  it('preserves a bold entity and escapes nothing inside plain bold text', () => {
    expect(toTelegramMarkdownV2('*bold*')).toBe('*bold*');
  });

  it('preserves an italic entity', () => {
    expect(toTelegramMarkdownV2('_italic_')).toBe('_italic_');
  });

  it('preserves a strikethrough entity', () => {
    expect(toTelegramMarkdownV2('~strike~')).toBe('~strike~');
  });

  it('preserves an inline code entity verbatim (no escaping of code content)', () => {
    expect(toTelegramMarkdownV2('`code.here()`')).toBe('`code.here()`');
  });

  it('preserves a triple-backtick code block verbatim across lines', () => {
    const input = '```\nconst x = 1;\n```';
    expect(toTelegramMarkdownV2(input)).toBe('```\nconst x = 1;\n```');
  });

  it('escapes backtick and backslash inside code content, nothing else', () => {
    expect(toTelegramMarkdownV2('`a\\b`c`')).toBe('`a\\\\b`c\\`');
  });

  it('escapes special characters in plain text surrounding an entity', () => {
    expect(toTelegramMarkdownV2('Check *this* out, it is cool!'))
      .toBe('Check *this* out, it is cool\\!');
  });

  it('handles mixed bold/italic/strike/code formatting in one message', () => {
    const input = 'Check *this* and _that_ plus `code` and ~gone~.';
    const result = toTelegramMarkdownV2(input);
    expect(result).toBe('Check *this* and _that_ plus `code` and ~gone~\\.');
  });

  it('escapes punctuation-heavy URLs outside entities', () => {
    const input = 'Visit https://example.com/path?query=1&x=2.';
    const result = toTelegramMarkdownV2(input);
    // '.', '-', '=' are escaped; '?', '&', ':', '/' are not MarkdownV2 special chars.
    expect(result).toBe('Visit https://example\\.com/path?query\\=1&x\\=2\\.');
  });

  it('escapes a URL embedded inside a bold entity', () => {
    const input = '*https://example.com*';
    expect(toTelegramMarkdownV2(input)).toBe('*https://example\\.com*');
  });
});

describe('toTelegramMarkdownV2 — pathological / malformed input', () => {
  it('does not crash and safely escapes a lone unmatched asterisk', () => {
    expect(toTelegramMarkdownV2('3 * 4 = 12')).toBe('3 \\* 4 \\= 12');
  });

  it('does not crash on a lone unmatched backtick', () => {
    expect(() => toTelegramMarkdownV2('a `b')).not.toThrow();
    expect(toTelegramMarkdownV2('a `b')).toBe('a \\`b');
  });

  it('does not crash on a lone unmatched underscore', () => {
    expect(toTelegramMarkdownV2('file_name')).toBe('file\\_name');
  });

  it('handles doubled asterisks (markdown-style **bold**) without throwing or leaving unbalanced escapes', () => {
    expect(() => toTelegramMarkdownV2('**not bold**')).not.toThrow();
    // The inner *not bold* is recognized as one bold entity; the outer
    // asterisks are literal and escaped. Documented v1 simplification —
    // this module does not implement double-asterisk bold.
    expect(toTelegramMarkdownV2('**not bold**')).toBe('\\**not bold*\\*');
  });

  it('escapes a run of nothing-but-special-characters without throwing', () => {
    const input = '_*[]()~`>#+-=|{}.!\\';
    expect(() => toTelegramMarkdownV2(input)).not.toThrow();
    const result = toTelegramMarkdownV2(input);
    expect(result).not.toContain('\0');
    expect(result.length).toBeGreaterThan(input.length);
  });

  it('treats nested delimiter characters inside an entity as literal, not nested entities (documented simplification)', () => {
    const input = '*bold _still bold_ text*';
    // The whole span is ONE bold entity (content excludes only '*' and
    // newline); the underscores inside are literal text and get escaped —
    // no nested italic entity is produced.
    expect(toTelegramMarkdownV2(input)).toBe('*bold \\_still bold\\_ text*');
  });

  it('handles an empty string', () => {
    expect(toTelegramMarkdownV2('')).toBe('');
  });

  it('handles a very long plain-text string without throwing', () => {
    const long = 'a.'.repeat(5000);
    expect(() => toTelegramMarkdownV2(long)).not.toThrow();
  });

  it('handles newlines inside plain text (not inside single-line entities)', () => {
    const input = 'line one\nline *two* here\nline.three';
    expect(toTelegramMarkdownV2(input)).toBe('line one\nline *two* here\nline\\.three');
  });

  it('does not allow a bold entity to span a newline', () => {
    const input = '*not\nclosed*';
    // No closing '*' on the same line as the opening one, so this falls
    // through to plain-text escaping rather than an invalid cross-line entity.
    expect(toTelegramMarkdownV2(input)).toBe('\\*not\nclosed\\*');
  });
});
