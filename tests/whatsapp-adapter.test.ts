import type { WAMessage } from '@whiskeysockets/baileys';
import { describe, expect, it, vi } from 'vitest';

import { createWhatsAppAdapter } from '../src/platforms/whatsapp/adapter.js';
import { createWhatsAppInboundMessageRef } from '../src/platforms/whatsapp/message-ref.js';
import { createMessageRef } from '../src/core/message-ref.js';

describe('WhatsApp adapter', () => {
  it('quotes inbound messages using minimal MessageRef', async () => {
    const sendMessage = vi.fn(async () => ({ key: { id: 'sent1', remoteJid: 'c1' } }));
    const sock = { sendMessage };

    const adapter = createWhatsAppAdapter(sock as never);

    const inbound = {
      key: { id: 'm1', remoteJid: 'c1' },
      message: { conversation: 'hi' },
    } as unknown as WAMessage;

    const replyTo = createWhatsAppInboundMessageRef('c1', inbound);

    await adapter.sendText('c1', 'hello', { replyTo });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const args = sendMessage.mock.calls[0];

    expect(args[0]).toBe('c1');
    expect(args[1]).toEqual({ text: 'hello' });

    const options = args[2] as { quoted?: unknown } | undefined;
    expect(options?.quoted).toBeTruthy();

    const quoted = options?.quoted as { key?: unknown; message?: unknown };
    expect(quoted.key).toEqual(inbound.key);
    expect(quoted.message).toEqual(inbound.message);
  });

  it('deletes messages by key using minimal MessageRef', async () => {
    const sendMessage = vi.fn(async () => ({ key: { id: 'sent1', remoteJid: 'c1' } }));
    const sock = { sendMessage };

    const adapter = createWhatsAppAdapter(sock as never);

    const inbound = {
      key: { id: 'm1', remoteJid: 'c1', fromMe: true },
      message: { conversation: 'hi' },
    } as unknown as WAMessage;

    const ref = createWhatsAppInboundMessageRef('c1', inbound);

    await adapter.deleteMessage('c1', ref);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('c1', { delete: inbound.key });
  });

  it('ignores non-whatsapp MessageRefs for quoting and deletion', async () => {
    const sendMessage = vi.fn(async () => ({ key: { id: 'sent1', remoteJid: 'c1' } }));
    const sock = { sendMessage };

    const adapter = createWhatsAppAdapter(sock as never);

    const slackRef = createMessageRef({
      platform: 'slack',
      chatId: 'c1',
      id: 's1',
      ref: { kind: 'slack-demo' },
    });

    await adapter.sendText('c1', 'hello', { replyTo: slackRef });
    await adapter.deleteMessage('c1', slackRef);

    // sendText should send without quote; delete should no-op.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('c1', { text: 'hello' }, undefined);
  });
});
