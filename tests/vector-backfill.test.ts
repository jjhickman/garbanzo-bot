process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const indexFact = vi.fn(async () => {});
const indexMessage = vi.fn(async () => {});
const indexSession = vi.fn(async () => {});
const getAllMemories = vi.fn(async () => [
  { id: 1, fact: 'Founded in 2024', category: 'general', source: 'owner', created_at: 10 },
  { id: 2, fact: 'Trivia Wednesdays', category: 'venues', source: 'owner', created_at: 20 },
]);
const getMessages = vi.fn(async () => []);
const listMessageChatJids = vi.fn(async () => [] as string[]);
const listSummarizedSessions = vi.fn(async () => []);

async function loadBackfill() {
  vi.resetModules();
  vi.doMock('../src/utils/vector-memory.js', () => ({
    indexFact,
    indexMessage,
    indexSession,
  }));
  vi.doMock('../src/utils/db.js', async () => ({
    ...(await vi.importActual<Record<string, unknown>>('../src/utils/db.js')),
    getAllMemories,
    getMessages,
    listMessageChatJids,
    listSummarizedSessions,
  }));
  return import('../src/utils/vector-backfill.js');
}

describe('vector backfill', () => {
  beforeEach(() => {
    indexFact.mockClear();
    indexMessage.mockClear();
    indexSession.mockClear();
    getAllMemories.mockReset();
    getAllMemories.mockResolvedValue([
      { id: 1, fact: 'Founded in 2024', category: 'general', source: 'owner', created_at: 10 },
      { id: 2, fact: 'Trivia Wednesdays', category: 'venues', source: 'owner', created_at: 20 },
    ]);
    getMessages.mockReset();
    getMessages.mockResolvedValue([]);
    listMessageChatJids.mockReset();
    listMessageChatJids.mockResolvedValue([]);
    listSummarizedSessions.mockReset();
    listSummarizedSessions.mockResolvedValue([]);
  });

  it('re-indexes all facts and reports progress', async () => {
    const mod = await loadBackfill();
    const progress = await mod.backfillVectors({ batchSize: 1, batchDelayMs: 0 });
    expect(indexFact).toHaveBeenCalledTimes(2);
    expect(progress.succeeded).toBe(2);
    expect(progress.failed).toBe(0);
  });

  it('reuses stored message timestamp and sender for message refIds, over all chats incl. DMs', async () => {
    getAllMemories.mockResolvedValue([]);
    // A group chat and a 1:1 DM chat — backfill enumerates both via listMessageChatJids.
    listMessageChatJids.mockResolvedValue(['g1@g.us', '15551234567@s.whatsapp.net']);
    getMessages.mockImplementation(async (chatJid: string) =>
      chatJid === 'g1@g.us'
        ? [{ timestamp: 1_700_000_123, sender: 'sender-bare', text: 'stored text' }]
        : [{ timestamp: 1_700_000_999, sender: 'dm-sender', text: 'dm text' }],
    );

    const mod = await loadBackfill();
    const progress = await mod.backfillVectors({ batchSize: 10, batchDelayMs: 0 });

    expect(indexMessage).toHaveBeenCalledWith({
      chatJid: 'g1@g.us',
      refId: '1700000123:sender-bare',
      sender: 'sender-bare',
      text: 'stored text',
      createdAt: 1_700_000_123,
    });
    // DM history is covered too (would have been skipped by the old GROUP_IDS-only enumeration).
    expect(indexMessage).toHaveBeenCalledWith({
      chatJid: '15551234567@s.whatsapp.net',
      refId: '1700000999:dm-sender',
      sender: 'dm-sender',
      text: 'dm text',
      createdAt: 1_700_000_999,
    });
    expect(progress.succeeded).toBe(2);
  });

  it('indexes sessions from the real listSummarizedSessions with stable refIds', async () => {
    getAllMemories.mockResolvedValue([]);
    listSummarizedSessions.mockResolvedValue([
      {
        sessionId: 42,
        chatJid: 'g1@g.us',
        startedAt: 100,
        endedAt: 200,
        messageCount: 3,
        participants: ['a', 'b'],
        topicTags: ['trivia'],
        summaryText: 'Discussed trivia plans in Cambridge.',
      },
    ]);

    const mod = await loadBackfill();
    const progress = await mod.backfillVectors({ batchSize: 10, batchDelayMs: 0 });

    expect(listSummarizedSessions).toHaveBeenCalled();
    expect(indexSession).toHaveBeenCalledWith(expect.objectContaining({
      chatJid: 'g1@g.us',
      refId: '42',
      summaryText: 'Discussed trivia plans in Cambridge.',
      createdAt: 200,
      extra: expect.objectContaining({ messageCount: 3, participants: ['a', 'b'] }),
    }));
    expect(progress.succeeded).toBe(1);
  });
});
