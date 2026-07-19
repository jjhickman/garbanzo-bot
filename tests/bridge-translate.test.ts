import { describe, expect, it } from 'vitest';
import {
  BRIDGE_MEDIA_MAX_BYTES_DEFAULT,
  BridgeEnvelopeSchema,
  bridgeMediaBase64MaxLength,
  buildIdempotencyKey,
  envelopeSupportsMedia,
  parseBridgeEnvelope,
} from '../src/bridge/envelope.js';
import { translateFormatting } from '../src/bridge/format-translate.js';

describe('translateFormatting', () => {
  it('translates WhatsApp formatting to Discord formatting', () => {
    expect(
      translateFormatting(
        '*bold* _italic_ ~strike~ `inline` ```mono```',
        'whatsapp',
        'discord',
      ),
    ).toBe('**bold** *italic* ~~strike~~ `inline` ```mono```');
  });

  it('translates Discord formatting to WhatsApp formatting', () => {
    expect(
      translateFormatting(
        '**bold** *italic* _also italic_ ~~strike~~ __underline__ `inline` ```mono```',
        'discord',
        'whatsapp',
      ),
    ).toBe('*bold* _italic_ _also italic_ ~strike~ underline `inline` ```mono```');
  });

  it('protects formatting markers inside code spans', () => {
    expect(
      translateFormatting('Code says `*not bold*` then *bold*', 'whatsapp', 'discord'),
    ).toBe('Code says `*not bold*` then **bold**');
  });

  it('does not translate formatting-looking characters inside URLs', () => {
    const text = 'See https://example.com/a_b_c?x=*y* and _real_';

    expect(translateFormatting(text, 'whatsapp', 'discord')).toBe(
      'See https://example.com/a_b_c?x=*y* and *real*',
    );
  });

  it('handles mixed nested markers without corrupting outer markers', () => {
    expect(translateFormatting('Mix **bold and *italic***', 'discord', 'whatsapp')).toBe(
      'Mix *bold and _italic_*',
    );
  });

  it('returns text unchanged for same-platform and unsupported platform pairs', () => {
    expect(translateFormatting('*same* _same_', 'whatsapp', 'whatsapp')).toBe('*same* _same_');
    expect(translateFormatting('*same* _same_', 'discord', 'discord')).toBe('*same* _same_');
    expect(translateFormatting('*slack* _text_', 'slack', 'discord')).toBe('*slack* _text_');
    // whatsapp -> matrix/telegram is deliberate identity: those adapters
    // already speak the whatsapp-style vocabulary at send time.
    expect(translateFormatting('*matrix* _text_', 'whatsapp', 'matrix')).toBe('*matrix* _text_');
  });

  it('translates Discord formatting to Matrix using the same whatsapp-style token mapping as Discord -> WhatsApp', () => {
    expect(translateFormatting('**bold** ~~strike~~', 'discord', 'matrix')).toBe(
      translateFormatting('**bold** ~~strike~~', 'discord', 'whatsapp'),
    );
  });

  it('translates Discord formatting to Telegram using the same whatsapp-style token mapping as Discord -> WhatsApp', () => {
    expect(
      translateFormatting(
        '**bold** *italic* _also italic_ ~~strike~~ __underline__ `inline` ```mono```',
        'discord',
        'telegram',
      ),
    ).toBe('*bold* _italic_ _also italic_ ~strike~ underline `inline` ```mono```');
  });

  it('leaves WhatsApp-origin text unchanged for a Telegram destination (already whatsapp-style)', () => {
    expect(translateFormatting('*bold* _italic_ ~strike~', 'whatsapp', 'telegram')).toBe(
      '*bold* _italic_ ~strike~',
    );
  });

  it('leaves Telegram-origin text unchanged for WhatsApp and Discord destinations (no inline markup to translate)', () => {
    expect(translateFormatting('*not bold* _not italic_', 'telegram', 'whatsapp')).toBe(
      '*not bold* _not italic_',
    );
    expect(translateFormatting('*not bold* _not italic_', 'telegram', 'discord')).toBe(
      '*not bold* _not italic_',
    );
  });

  it('does not corrupt user text that collides with the internal placeholder format', () => {
    // Regression test for a sentinel-collision bug: the old implementation protected
    // code spans/URLs with an in-band sentinel ("BRIDGE<i>") restored via
    // replaceAll. If user text already contained that exact literal sentinel, restoring
    // the real protected value (e.g. a code span) would corrupt BOTH the genuine
    // placeholder and the coincidental literal occurrence. The segment-model rewrite is
    // structurally immune: there is no in-band sentinel to collide with.
    const sentinelLookalike = 'BRIDGE0';
    const text = `${sentinelLookalike} \`code\` *bold*`;

    expect(translateFormatting(text, 'whatsapp', 'discord')).toBe(
      `${sentinelLookalike} \`code\` **bold**`,
    );
  });

  it('includes balanced parentheses in URLs and trims trailing punctuation', () => {
    const text = 'See https://example.com/a_(b)_ and _real_';

    expect(translateFormatting(text, 'whatsapp', 'discord')).toBe(
      'See https://example.com/a_(b)_ and *real*',
    );
  });

  it('trims trailing sentence punctuation off a protected URL', () => {
    const text = 'Visit https://example.com/a_b_. Then _italic_';

    expect(translateFormatting(text, 'whatsapp', 'discord')).toBe(
      'Visit https://example.com/a_b_. Then *italic*',
    );
  });
});

describe('BridgeEnvelopeSchema', () => {
  const validEnvelope = {
    v: 1,
    routeId: 'route-1',
    origin: {
      instance: 'whatsapp-community',
      platform: 'whatsapp',
      chatId: 'chat-1',
      messageId: 'message-1',
      senderId: 'sender-1',
      senderName: 'Ana',
    },
    targetInstance: 'discord-community',
    targetChatId: 'channel-1',
    text: 'hello',
    kind: 'message',
    sentAtMs: 1_788_221_000_000,
    idempotencyKey: '["whatsapp-community","chat-1","message-1","discord-community","channel-1"]',
  } as const;
  const validMedia = {
    data: Buffer.from('test image').toString('base64'),
    mimetype: 'image/png',
    fileName: 'photo.png',
    kind: 'image',
    ptt: false,
  } as const;

  it('accepts a valid bridge envelope and preserves its fields', () => {
    const parsed = BridgeEnvelopeSchema.parse(validEnvelope);

    expect(parsed).toEqual(validEnvelope);
    expect(parseBridgeEnvelope(validEnvelope)).toEqual(validEnvelope);
  });

  it('accepts optional origin chatName while preserving strict unknown-key rejection', () => {
    const withChatName = {
      ...validEnvelope,
      origin: { ...validEnvelope.origin, chatName: 'General' },
    };

    expect(BridgeEnvelopeSchema.parse(withChatName)).toEqual(withChatName);
    expect(parseBridgeEnvelope(withChatName)).toEqual(withChatName);
  });

  it('rejects unsupported versions, missing fields, and empty strings', () => {
    expect(BridgeEnvelopeSchema.safeParse({ ...validEnvelope, v: 3 }).success).toBe(false);
    expect(BridgeEnvelopeSchema.safeParse({ ...validEnvelope, routeId: '' }).success).toBe(false);

    const { targetChatId: _targetChatId, ...missingTargetChatId } = validEnvelope;
    expect(BridgeEnvelopeSchema.safeParse(missingTargetChatId).success).toBe(false);

    expect(
      BridgeEnvelopeSchema.safeParse({
        ...validEnvelope,
        origin: { ...validEnvelope.origin, chatId: '' },
      }).success,
    ).toBe(false);
  });

  it('rejects media on a v1 envelope', () => {
    expect(BridgeEnvelopeSchema.safeParse({ ...validEnvelope, media: validMedia }).success).toBe(false);
  });

  it('accepts allowlisted media within the configured cap on a v2 envelope', () => {
    const envelope = { ...validEnvelope, v: 2, media: validMedia } as const;
    const parsed = BridgeEnvelopeSchema.parse(envelope);

    expect(parsed).toEqual(envelope);
    expect(envelopeSupportsMedia(parsed)).toBe(true);
  });

  it('rejects v2 media whose base64 data exceeds the configured cap', () => {
    const overLimitData = 'A'.repeat(
      bridgeMediaBase64MaxLength(BRIDGE_MEDIA_MAX_BYTES_DEFAULT) + 4,
    );

    expect(BridgeEnvelopeSchema.safeParse({
      ...validEnvelope,
      v: 2,
      media: { ...validMedia, data: overLimitData },
    }).success).toBe(false);
  });

  it('rejects v2 media with a non-allowlisted mimetype', () => {
    expect(BridgeEnvelopeSchema.safeParse({
      ...validEnvelope,
      v: 2,
      media: { ...validMedia, mimetype: 'image/svg+xml' },
    }).success).toBe(false);
  });

  it('builds idempotency keys from origin and target identity', () => {
    expect(buildIdempotencyKey(validEnvelope.origin, {
      instance: validEnvelope.targetInstance,
      chatId: validEnvelope.targetChatId,
    })).toBe('["whatsapp-community","chat-1","message-1","discord-community","channel-1"]');
  });

  it('produces distinct keys for colon-bearing Matrix-style ids that would collide under a naive ":" join', () => {
    // Under a plain `a:b:c:d:e` join both tuples flatten to the identical
    // string "mx:!r:e:mx:!r:e2" vs "mx:!r:e:e2:mx:!r:e" — the field
    // boundaries are lost. Two DISTINCT origin/target tuples:
    const keyA = buildIdempotencyKey(
      { instance: 'mx', chatId: '!room:hs', messageId: '$event:hs' },
      { instance: 'mx2', chatId: '!other:hs' },
    );
    const keyB = buildIdempotencyKey(
      { instance: 'mx', chatId: '!room:hs', messageId: '$event' },
      { instance: 'hs:mx2', chatId: '!other:hs' },
    );

    expect(keyA).not.toBe(keyB);
  });

  it('produces an identical key when the same leg is retried (exactly-once preserved)', () => {
    const origin = { instance: 'mx', chatId: '!room:hs', messageId: '$event:hs' };
    const target = { instance: 'discord-main', chatId: 'channel:with:colons' };

    expect(buildIdempotencyKey(origin, target)).toBe(buildIdempotencyKey(origin, target));
  });

  it('returns null instead of throwing on invalid raw input', () => {
    expect(parseBridgeEnvelope('not json')).toBeNull();
    expect(parseBridgeEnvelope(null)).toBeNull();
    expect(parseBridgeEnvelope({ ...validEnvelope, kind: 'other' })).toBeNull();
  });

  it('rejects an unknown top-level key', () => {
    expect(
      BridgeEnvelopeSchema.safeParse({ ...validEnvelope, extra: 'nope' }).success,
    ).toBe(false);
    expect(parseBridgeEnvelope({ ...validEnvelope, extra: 'nope' })).toBeNull();
  });

  it('rejects an unknown origin key', () => {
    expect(
      BridgeEnvelopeSchema.safeParse({
        ...validEnvelope,
        origin: { ...validEnvelope.origin, extra: 'nope' },
      }).success,
    ).toBe(false);
    expect(
      parseBridgeEnvelope({
        ...validEnvelope,
        origin: { ...validEnvelope.origin, extra: 'nope' },
      }),
    ).toBeNull();
  });
});
