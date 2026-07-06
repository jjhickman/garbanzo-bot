import { describe, expect, it } from 'vitest';
import { parseBridgeEnvelope, buildIdempotencyKey, BridgeEnvelopeSchema } from '../src/bridge/envelope.js';
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
    expect(translateFormatting('*teams* _text_', 'discord', 'teams')).toBe('*teams* _text_');
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
    idempotencyKey: 'whatsapp-community:chat-1:message-1',
  } as const;

  it('accepts a valid bridge envelope and preserves its fields', () => {
    const parsed = BridgeEnvelopeSchema.parse(validEnvelope);

    expect(parsed).toEqual(validEnvelope);
    expect(parseBridgeEnvelope(validEnvelope)).toEqual(validEnvelope);
  });

  it('rejects unsupported versions, missing fields, and empty strings', () => {
    expect(BridgeEnvelopeSchema.safeParse({ ...validEnvelope, v: 2 }).success).toBe(false);
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

  it('builds idempotency keys from origin identity', () => {
    expect(buildIdempotencyKey(validEnvelope.origin)).toBe('whatsapp-community:chat-1:message-1');
  });

  it('returns null instead of throwing on invalid raw input', () => {
    expect(parseBridgeEnvelope('not json')).toBeNull();
    expect(parseBridgeEnvelope(null)).toBeNull();
    expect(parseBridgeEnvelope({ ...validEnvelope, kind: 'other' })).toBeNull();
  });
});
