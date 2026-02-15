import { describe, it, expect } from 'vitest';

import { createSlackDemoAdapter } from '../src/platforms/slack/adapter.js';
import { normalizeSlackDemoInbound, processSlackDemoInbound } from '../src/platforms/slack/processor.js';

describe('Slack demo runtime', () => {
  it('routes @garbanzo !help through the core pipeline', async () => {
    const outbox: Array<{ type: string; chatId: string; payload: unknown }> = [];
    const messenger = createSlackDemoAdapter(outbox);

    const inbound = normalizeSlackDemoInbound({
      chatId: 'C123',
      senderId: 'U123',
      text: '@garbanzo !help',
      isGroupChat: true,
    });

    await processSlackDemoInbound(messenger, inbound, { ownerId: 'owner@s.whatsapp.net' });

    expect(outbox.length).toBeGreaterThan(0);
    const first = outbox[0];
    expect(first.type).toBe('text');

    const payload = first.payload as { text?: unknown };
    expect(typeof payload.text).toBe('string');
    expect(String(payload.text)).toContain('Garbanzo Bean');
  });
});
