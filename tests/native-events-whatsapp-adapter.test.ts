import { describe, expect, it, vi } from 'vitest';

import { createWhatsAppAdapter } from '../src/platforms/whatsapp/adapter.js';

const START_MS = Date.parse('2026-08-01T23:00:00.000Z');
const END_MS = START_MS + 60 * 60 * 1000;

function requireCapability<T>(fn: T | undefined): T {
  if (!fn) throw new Error('adapter is missing a native-event capability');
  return fn;
}

function makeSock(result: unknown = { key: { id: 'sent-1', remoteJid: 'group@g.us', fromMe: true } }) {
  const sendMessage = vi.fn(async () => result);
  return { sendMessage, sock: { sendMessage } };
}

describe('WhatsApp adapter native events', () => {
  it('creates an event message with the Baileys event shape and returns the message key ref', async () => {
    const { sendMessage, sock } = makeSock();
    const adapter = createWhatsAppAdapter(sock as never);

    const ref = await requireCapability(adapter.createNativeEvent)('group@g.us', {
      name: 'Trivia Night',
      description: 'Come hang',
      startAtMs: START_MS,
      endAtMs: END_MS,
      location: 'The Pub',
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, content] = sendMessage.mock.calls[0] as [string, { event: Record<string, unknown> }];
    expect(chatId).toBe('group@g.us');
    expect(content.event).toEqual({
      name: 'Trivia Night',
      description: 'Come hang',
      startDate: new Date(START_MS),
      endDate: new Date(END_MS),
      location: { name: 'The Pub' },
      isCancelled: false,
    });

    expect(JSON.parse(ref)).toEqual({ id: 'sent-1', remoteJid: 'group@g.us', fromMe: true });
  });

  it('omits optional fields when the payload leaves them unset', async () => {
    const { sendMessage, sock } = makeSock();
    const adapter = createWhatsAppAdapter(sock as never);

    await requireCapability(adapter.createNativeEvent)('group@g.us', { name: 'Minimal', startAtMs: START_MS });

    const [, content] = sendMessage.mock.calls[0] as [string, { event: Record<string, unknown> }];
    expect(content.event).toEqual({
      name: 'Minimal',
      description: undefined,
      startDate: new Date(START_MS),
      endDate: undefined,
      location: undefined,
      isCancelled: false,
    });
  });

  it('sends a corrected replacement event message on update and returns the NEW message key', async () => {
    const { sendMessage, sock } = makeSock({ key: { id: 'sent-2', remoteJid: 'group@g.us', fromMe: true } });
    const adapter = createWhatsAppAdapter(sock as never);

    const oldRef = JSON.stringify({ id: 'sent-1', remoteJid: 'group@g.us', fromMe: true });
    const newRef = await requireCapability(adapter.updateNativeEvent)('group@g.us', oldRef, {
      name: 'Trivia Night (moved)',
      startAtMs: START_MS + 24 * 60 * 60 * 1000,
    });

    // Replacement message, not an edit: a fresh { event } send.
    const [, content] = sendMessage.mock.calls[0] as [string, { event: Record<string, unknown> }];
    expect(content.event).toMatchObject({ name: 'Trivia Night (moved)', isCancelled: false });
    expect(JSON.parse(newRef).id).toBe('sent-2');
    expect(newRef).not.toBe(oldRef);
  });

  it('sends the event with isCancelled true on cancel', async () => {
    const { sendMessage, sock } = makeSock();
    const adapter = createWhatsAppAdapter(sock as never);

    const ref = JSON.stringify({ id: 'sent-1', remoteJid: 'group@g.us', fromMe: true });
    await requireCapability(adapter.cancelNativeEvent)('group@g.us', ref, {
      name: 'Trivia Night',
      startAtMs: START_MS,
      location: 'The Pub',
    });

    const [, content] = sendMessage.mock.calls[0] as [string, { event: Record<string, unknown> }];
    expect(content.event).toMatchObject({
      name: 'Trivia Night',
      isCancelled: true,
      location: { name: 'The Pub' },
    });
  });

  it('never stores the string "null" as a ref when Baileys returns no message key', async () => {
    // Send succeeded but the ack carried no key (Baileys edge case).
    const { sock } = makeSock({});
    const adapter = createWhatsAppAdapter(sock as never);

    const created = await requireCapability(adapter.createNativeEvent)('group@g.us', { name: 'X', startAtMs: START_MS });
    expect(created).not.toBe('null');
    expect(JSON.parse(created)).toEqual({ missingKey: true });

    const updated = await requireCapability(adapter.updateNativeEvent)('group@g.us', created, { name: 'X2', startAtMs: START_MS });
    expect(updated).not.toBe('null');
    expect(JSON.parse(updated)).toEqual({ missingKey: true });
  });

  it('lets a safety-layer held error propagate untouched (queued, not failed)', async () => {
    const held = new Error('WhatsApp outbound job #7 held: paused');
    held.name = 'WhatsAppOutboundHeldError';
    const sendMessage = vi.fn(async () => {
      throw held;
    });
    const adapter = createWhatsAppAdapter({ sendMessage } as never);

    await expect(requireCapability(adapter.createNativeEvent)('group@g.us', { name: 'X', startAtMs: START_MS }))
      .rejects.toBe(held);
  });
});
