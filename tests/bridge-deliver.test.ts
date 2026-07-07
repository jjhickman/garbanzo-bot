import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessagingPlatform } from '../src/core/messaging-platform.js';
import type { PlatformMessenger } from '../src/core/platform-messenger.js';
import type { BridgeEnvelope } from '../src/bridge/envelope.js';
import { createRelayDeliverer } from '../src/bridge/relay-deliver.js';
import { WhatsAppOutboundHeldError } from '../src/platforms/whatsapp/outbound-safety.js';
import { config } from '../src/utils/config.js';

type SendText = Pick<PlatformMessenger, 'sendText'>['sendText'];

const BASE_ENVELOPE: BridgeEnvelope = {
  v: 1,
  routeId: 'route-1',
  origin: {
    instance: 'whatsapp-main',
    platform: 'whatsapp',
    chatId: 'source-chat',
    messageId: 'message-1',
    senderId: 'sender-1',
    senderName: 'Ana',
  },
  targetInstance: 'discord-main',
  targetChatId: 'target-chat',
  text: 'hello',
  kind: 'message',
  sentAtMs: 1_800_000_000_000,
  idempotencyKey: 'whatsapp-main:source-chat:message-1',
};

function envelope(overrides: Partial<BridgeEnvelope> = {}): BridgeEnvelope {
  return {
    ...BASE_ENVELOPE,
    ...overrides,
    origin: {
      ...BASE_ENVELOPE.origin,
      ...(overrides.origin ?? {}),
    },
  };
}

function deliverer(
  options: {
    platform?: MessagingPlatform;
    sendText?: SendText;
    bufferEnvelope?: (env: BridgeEnvelope) => Promise<void>;
  } = {},
): {
  deliver: ReturnType<typeof createRelayDeliverer>;
  sendText: ReturnType<typeof vi.fn<SendText>>;
  bufferEnvelope: ReturnType<typeof vi.fn<(env: BridgeEnvelope) => Promise<void>>>;
} {
  const sendText = vi.fn<SendText>(options.sendText ?? (async () => undefined));
  const bufferEnvelope = vi.fn<(env: BridgeEnvelope) => Promise<void>>(
    options.bufferEnvelope ?? (async () => undefined),
  );

  return {
    deliver: createRelayDeliverer({
      messenger: { sendText },
      platform: options.platform ?? 'discord',
      bufferEnvelope,
    }),
    sendText,
    bufferEnvelope,
  };
}

describe('createRelayDeliverer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers text with sender name attribution and origin platform label', async () => {
    const { deliver, sendText } = deliverer({ platform: 'discord' });

    await expect(deliver.deliver(envelope({ text: 'hello relay' }))).resolves.toBe('sent');

    expect(sendText).toHaveBeenCalledWith('target-chat', 'Ana (WhatsApp): hello relay');
  });

  it('includes origin chat display name in attribution when present', async () => {
    const { deliver, sendText } = deliverer({ platform: 'discord' });

    await deliver.deliver(envelope({ origin: { chatName: 'General' } }));

    expect(sendText).toHaveBeenCalledWith('target-chat', 'Ana (WhatsApp · General): hello');
  });

  it('falls back to sender id when sender name is missing', async () => {
    const { deliver, sendText } = deliverer({ platform: 'discord' });

    await deliver.deliver(envelope({ origin: { senderName: undefined } }));

    expect(sendText).toHaveBeenCalledWith('target-chat', 'sender-1 (WhatsApp): hello');
  });

  it('translates formatting for the target platform', async () => {
    const { deliver, sendText } = deliverer({ platform: 'discord' });

    await deliver.deliver(envelope({ text: '*bold*' }));

    expect(sendText).toHaveBeenCalledWith('target-chat', 'Ana (WhatsApp): **bold**');
  });

  it('does not translate media placeholders', async () => {
    const { deliver, sendText } = deliverer({ platform: 'discord' });

    await deliver.deliver(envelope({ kind: 'media-placeholder', text: '*[voice note]*' }));

    expect(sendText).toHaveBeenCalledWith('target-chat', 'Ana (WhatsApp): *[voice note]*');
  });

  it('hard-clamps the composed string when the sender name alone exceeds BRIDGE_MAX_TEXT', async () => {
    const { deliver, sendText } = deliverer({ platform: 'discord' });
    const absurdName = 'x'.repeat(2000);

    await deliver.deliver(envelope({ text: 'hello', origin: { senderName: absurdName } }));

    const sentText = sendText.mock.calls[0]?.[1] ?? '';
    expect(sentText.length).toBeLessThanOrEqual(config.BRIDGE_MAX_TEXT);
  });

  it('keeps the attribution prefix when truncating long bodies', async () => {
    const { deliver, sendText } = deliverer({ platform: 'discord' });
    const prefix = 'Ana (WhatsApp): ';

    await deliver.deliver(envelope({ text: 'x'.repeat(config.BRIDGE_MAX_TEXT * 2) }));

    const sentText = sendText.mock.calls[0]?.[1] ?? '';
    expect(sentText).toHaveLength(config.BRIDGE_MAX_TEXT);
    expect(sentText.startsWith(prefix)).toBe(true);
    expect(sentText).toMatch(/\.\.\.$/);
  });

  it('buffers WhatsApp held sends without retrying', async () => {
    const held = new WhatsAppOutboundHeldError(7, 'daily limit');
    const { deliver, sendText, bufferEnvelope } = deliverer({
      platform: 'whatsapp',
      sendText: async () => {
        throw held;
      },
    });
    const env = envelope();

    await expect(deliver.deliver(env)).resolves.toBe('buffered');

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(bufferEnvelope).toHaveBeenCalledTimes(1);
    expect(bufferEnvelope).toHaveBeenCalledWith(env);
  });

  it('rethrows non-held errors without buffering', async () => {
    const failure = new Error('boom');
    const { deliver, sendText, bufferEnvelope } = deliverer({
      platform: 'whatsapp',
      sendText: async () => {
        throw failure;
      },
    });

    await expect(deliver.deliver(envelope())).rejects.toBe(failure);

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(bufferEnvelope).not.toHaveBeenCalled();
  });

  it('retries a Discord 429 once after the parseable retry delay', async () => {
    vi.useFakeTimers();
    const sendText = vi.fn<SendText>()
      .mockRejectedValueOnce(new Error('Discord API /channels/target/messages failed (429): {"retry_after":0.25}'))
      .mockResolvedValueOnce(undefined);
    const { deliver } = deliverer({ platform: 'discord', sendText });

    const result = deliver.deliver(envelope());
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toBe('sent');
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it('rethrows when a Discord 429 retry also fails', async () => {
    vi.useFakeTimers();
    const secondFailure = new Error('Discord API /channels/target/messages failed (429): {"retry_after":0.1}');
    const sendText = vi.fn<SendText>()
      .mockRejectedValueOnce(new Error('Discord API /channels/target/messages failed (429): {"retry_after":0.1}'))
      .mockRejectedValueOnce(secondFailure);
    const { deliver } = deliverer({ platform: 'discord', sendText });

    const result = expect(deliver.deliver(envelope())).rejects.toBe(secondFailure);
    await vi.advanceTimersByTimeAsync(100);

    await result;
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-429 Discord errors', async () => {
    const failure = new Error('Discord API /channels/target/messages failed (500): server error');
    const { deliver, sendText } = deliverer({
      platform: 'discord',
      sendText: async () => {
        throw failure;
      },
    });

    await expect(deliver.deliver(envelope())).rejects.toBe(failure);

    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('does not import or call the WhatsApp control-send bypass', () => {
    const source = readFileSync('src/bridge/relay-deliver.ts', 'utf8');

    expect(source).not.toContain('sendControlText');
  });
});
