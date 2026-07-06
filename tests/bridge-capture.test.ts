process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { describe, expect, it, vi } from 'vitest';
import type { BridgeMap } from '../src/bridge/bridge-map.js';
import type { BridgeEnvelope } from '../src/bridge/envelope.js';
import { createRelayCapture } from '../src/bridge/relay-capture.js';
import { createMessageRef } from '../src/core/message-ref.js';
import type { InboundMessage } from '../src/core/inbound-message.js';

const MAP: BridgeMap = {
  instances: [
    { id: 'discord-band', platform: 'discord' },
    { id: 'whatsapp-band', platform: 'whatsapp' },
  ],
  routes: [
    {
      id: 'band-both',
      endpoints: [
        { instance: 'discord-band', chatId: 'chan-1' },
        { instance: 'whatsapp-band', chatId: 'group-1@g.us' },
      ],
      direction: 'both',
      modeToWhatsApp: 'summary',
      modeToDiscord: 'verbatim',
      relayCommands: false,
    },
    {
      id: 'oneway-d2w',
      endpoints: [
        { instance: 'discord-band', chatId: 'chan-2' },
        { instance: 'whatsapp-band', chatId: 'group-2@g.us' },
      ],
      direction: 'one-way',
      from: 'discord-band',
      modeToWhatsApp: 'summary',
      modeToDiscord: 'verbatim',
      relayCommands: false,
    },
    {
      id: 'relay-cmds',
      endpoints: [
        { instance: 'discord-band', chatId: 'chan-3' },
        { instance: 'whatsapp-band', chatId: 'group-3@g.us' },
      ],
      direction: 'both',
      modeToWhatsApp: 'summary',
      modeToDiscord: 'verbatim',
      relayCommands: true,
    },
  ],
};

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'discord',
    chatId: 'chan-1',
    senderId: 'sender-1',
    senderName: 'Ana',
    messageId: 'msg-1',
    fromSelf: false,
    isStatusBroadcast: false,
    isGroupChat: true,
    timestampMs: 1_800_000_000_000,
    text: 'hello world',
    hasVisualMedia: false,
    raw: createMessageRef({ platform: 'discord', chatId: 'chan-1', id: 'msg-1', ref: {} }),
    ...overrides,
  };
}

function capture(instanceId: string, map: BridgeMap = MAP) {
  const enqueue = vi.fn<(env: BridgeEnvelope) => Promise<void>>(async () => undefined);
  return { relay: createRelayCapture({ instanceId, bridgeMap: map, enqueue }), enqueue };
}

describe('createRelayCapture', () => {
  it('enqueues a text message envelope addressed to the route\'s other endpoint', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound());

    expect(enqueue).toHaveBeenCalledTimes(1);
    const envelope = enqueue.mock.calls[0]?.[0];
    expect(envelope).toMatchObject({
      v: 1,
      routeId: 'band-both',
      targetInstance: 'whatsapp-band',
      targetChatId: 'group-1@g.us',
      text: 'hello world',
      kind: 'message',
      idempotencyKey: 'discord-band:chan-1:msg-1',
      origin: {
        instance: 'discord-band',
        platform: 'discord',
        chatId: 'chan-1',
        messageId: 'msg-1',
        senderId: 'sender-1',
        senderName: 'Ana',
      },
    });
  });

  it('is a no-op when no route matches the chat id', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ chatId: 'unmapped-chat' }));

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('allows either endpoint to send on a both-direction route', () => {
    const discordSide = capture('discord-band');
    discordSide.relay.capture(inbound({ chatId: 'chan-1' }));
    expect(discordSide.enqueue).toHaveBeenCalledTimes(1);

    const whatsappSide = capture('whatsapp-band');
    whatsappSide.relay.capture(inbound({
      platform: 'whatsapp',
      chatId: 'group-1@g.us',
      messageId: 'wa-msg-1',
    }));
    expect(whatsappSide.enqueue).toHaveBeenCalledTimes(1);
  });

  it('only relays in the declared direction on a one-way route', () => {
    const fromSide = capture('discord-band');
    fromSide.relay.capture(inbound({ chatId: 'chan-2' }));
    expect(fromSide.enqueue).toHaveBeenCalledTimes(1);

    const toSide = capture('whatsapp-band');
    toSide.relay.capture(inbound({
      platform: 'whatsapp',
      chatId: 'group-2@g.us',
      messageId: 'wa-msg-2',
    }));
    expect(toSide.enqueue).not.toHaveBeenCalled();
  });

  it('skips bang-commands when the route does not allow relayCommands', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ text: '!song list' }));

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('relays bang-commands when the route allows relayCommands', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ chatId: 'chan-3', text: '!song list' }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ routeId: 'relay-cmds', text: '!song list' });
  });

  it('builds a voice-note placeholder for audio-only messages', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ text: null, audio: { url: 'https://cdn.example/a.ogg', contentType: 'audio/ogg' } }));

    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ kind: 'media-placeholder', text: '[voice note]' });
  });

  it('builds an image placeholder for visual-media-only messages', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ text: null, hasVisualMedia: true }));

    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ kind: 'media-placeholder', text: '[image]' });
  });

  it('appends caption text to a media placeholder', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ text: 'check this out', hasVisualMedia: true }));

    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ kind: 'media-placeholder', text: '[image] check this out' });
  });

  it('is a no-op for messages with no text, audio, or visual media', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ text: null }));

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('skips capture when the inbound message has no messageId', () => {
    const { relay, enqueue } = capture('discord-band');

    relay.capture(inbound({ messageId: undefined }));

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never throws even when the enqueue promise rejects', async () => {
    const enqueue = vi.fn<(env: BridgeEnvelope) => Promise<void>>(async () => {
      throw new Error('outbox unavailable');
    });
    const relay = createRelayCapture({ instanceId: 'discord-band', bridgeMap: MAP, enqueue });

    expect(() => relay.capture(inbound())).not.toThrow();

    // Let the rejected microtask settle before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('capture() returns synchronously without awaiting the enqueue promise', () => {
    let resolveEnqueue: (() => void) | undefined;
    const enqueue = vi.fn<(env: BridgeEnvelope) => Promise<void>>(
      () => new Promise((resolve) => { resolveEnqueue = () => resolve(undefined); }),
    );
    const relay = createRelayCapture({ instanceId: 'discord-band', bridgeMap: MAP, enqueue });

    const result = relay.capture(inbound());

    expect(result).toBeUndefined();
    resolveEnqueue?.();
  });
});
