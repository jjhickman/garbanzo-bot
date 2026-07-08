import { describe, expect, it } from 'vitest';

import {
  stripMatrixReplyFallback,
  toMatrixFormattedText,
  toMatrixMessageContent,
} from '../src/platforms/matrix/markdown.js';

describe('toMatrixFormattedText', () => {
  it('builds plain body and Matrix HTML for supported entities', () => {
    expect(toMatrixFormattedText('Check *this* and _that_ plus `code` and ~gone~.')).toEqual({
      body: 'Check this and that plus code and gone.',
      formattedBody: 'Check <strong>this</strong> and <em>that</em> plus <code>code</code> and <del>gone</del>.',
    });
  });

  it('escapes HTML metacharacters outside and inside entities', () => {
    expect(toMatrixFormattedText('<a> *b&c* "q"').formattedBody)
      .toBe('&lt;a&gt; <strong>b&amp;c</strong> &quot;q&quot;');
  });

  it('renders code blocks as pre/code', () => {
    expect(toMatrixFormattedText('```\nconst x = 1 < 2;\n```').formattedBody)
      .toBe('<pre><code>\nconst x = 1 &lt; 2;\n</code></pre>');
  });

  it('does not bold arithmetic asterisks with whitespace on both sides', () => {
    const result = toMatrixFormattedText('a * b * c');
    expect(result.body).toBe('a * b * c');
    expect(result.formattedBody).toBe('a * b * c');
  });

  it('does not italicize across snake_case identifiers', () => {
    expect(toMatrixFormattedText('use snake_case and other_var here').formattedBody)
      .toBe('use snake_case and other_var here');
  });

  it('does not italicize underscore-delimited segments inside URLs', () => {
    expect(toMatrixFormattedText('https://example.com/some_page_here').formattedBody)
      .toBe('https://example.com/some_page_here');
  });

  it('escapes adjacent double-underscore runs instead of guessing a pairing', () => {
    expect(toMatrixFormattedText('_a__b_').formattedBody).toBe('_a__b_');
  });

  it('still allows genuine word-boundary-delimited italics next to punctuation', () => {
    expect(toMatrixFormattedText('say (_hi_) now').formattedBody).toBe('say (<em>hi</em>) now');
  });
});

describe('toMatrixMessageContent', () => {
  it('builds both plain body and formatted_body', () => {
    const content = toMatrixMessageContent('!room:example.org', 'Hello *world*');

    expect(content.body).toBe('Hello world');
    expect(content.format).toBe('org.matrix.custom.html');
    expect(content.formatted_body).toBe('Hello <strong>world</strong>');
  });

  it('adds Matrix reply metadata and an mx-reply fallback for replies', () => {
    const content = toMatrixMessageContent('!room:example.org', 'reply', '$event');

    expect(content['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: '$event' } });
    expect(content.formatted_body).toContain('<mx-reply>');
    expect(content.formatted_body).toContain('reply');
  });
});

describe('stripMatrixReplyFallback', () => {
  it('strips formatted mx-reply fallback', () => {
    expect(stripMatrixReplyFallback('<mx-reply><blockquote>old</blockquote></mx-reply>new'))
      .toBe('new');
  });

  it('strips plain quoted fallback lines', () => {
    expect(stripMatrixReplyFallback('> <@a:b> old\n> more\n\nnew'))
      .toBe('new');
  });
});
