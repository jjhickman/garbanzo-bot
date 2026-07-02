import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_openrouter';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

type MemoryEntry = {
  id: number;
  fact: string;
  category: string;
  source: string;
  created_at: number;
};

type MockOptions = {
  enabled?: boolean;
  minMessages?: number;
  intervalMinutes?: number;
  maxFacts?: number;
  messages?: Array<{ sender: string; text: string; timestamp?: number }>;
  aiResponse?: string | Promise<string | null> | null;
  existingMemories?: MemoryEntry[];
};

function mockDeps(options: MockOptions = {}) {
  const memories: MemoryEntry[] = [...(options.existingMemories ?? [])];
  let nextId = memories.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
  const getAIResponse = vi.fn(async () => options.aiResponse ?? '[]');
  const messageLog = [
    ...(options.messages ?? [
      { sender: 'alice@s.whatsapp.net', text: 'Board game night is every Tuesday at Aeronaut.', timestamp: 100 },
      { sender: 'bob@s.whatsapp.net', text: 'New members should ask Sam about the hiking spreadsheet.', timestamp: 101 },
    ]),
  ];
  const getMessages = vi.fn(async () => messageLog);
  const addMemory = vi.fn(async (fact: string, category: string, source: string) => {
    const entry = {
      id: nextId++,
      fact,
      category,
      source,
      created_at: Math.floor(Date.now() / 1000),
    };
    memories.push(entry);
    return entry;
  });
  const deleteMemory = vi.fn(async (id: number) => {
    const index = memories.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    memories.splice(index, 1);
    return true;
  });
  const searchMemory = vi.fn(async (keyword: string) => (
    memories.filter((entry) => entry.fact.toLowerCase().includes(keyword.toLowerCase()))
  ));
  const getAllMemories = vi.fn(async () => memories);

  vi.doMock('../src/utils/config.js', () => ({
    config: {
      MEMORY_AUTO_EXTRACT: options.enabled ?? true,
      MEMORY_AUTO_EXTRACT_MIN_MESSAGES: options.minMessages ?? 2,
      MEMORY_AUTO_EXTRACT_INTERVAL_MINUTES: options.intervalMinutes ?? 10,
      MEMORY_AUTO_MAX_FACTS: options.maxFacts ?? 200,
    },
  }));
  vi.doMock('../src/ai/router.js', () => ({ getAIResponse }));
  vi.doMock('../src/utils/db.js', () => ({
    addMemory,
    deleteMemory,
    getAllMemories,
    getMessages,
    searchMemory,
  }));
  vi.doMock('../src/middleware/logger.js', () => ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

  return { addMemory, deleteMemory, getAIResponse, getMessages, memories, messageLog, searchMemory };
}

describe('community memory extraction', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not call the LLM when disabled', async () => {
    const mocks = mockDeps({ enabled: false });
    const { maybeExtractCommunityFacts } = await import('../src/features/memory-extract.js');

    await maybeExtractCommunityFacts('chat@g.us', 'General');
    await maybeExtractCommunityFacts('chat@g.us', 'General');

    expect(mocks.getAIResponse).not.toHaveBeenCalled();
    expect(mocks.addMemory).not.toHaveBeenCalled();
  });

  it('requires fresh messages and the interval before extracting again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-02T12:00:00Z'));
    const nowSeconds = () => Math.floor(Date.now() / 1000);
    const mocks = mockDeps({
      minMessages: 3,
      intervalMinutes: 60,
      messages: [
        { sender: 'a@s.whatsapp.net', text: 'Board game night is every Tuesday at Aeronaut.', timestamp: 100 },
        { sender: 'b@s.whatsapp.net', text: 'Ask Sam about the hiking spreadsheet.', timestamp: 101 },
      ],
      aiResponse: '[{"category":"events","fact":"Board game night happens every Tuesday at Aeronaut."}]',
    });
    const { maybeExtractCommunityFacts } = await import('../src/features/memory-extract.js');

    // Only 2 fresh messages < threshold of 3 — no extraction.
    await maybeExtractCommunityFacts('chat@g.us', 'General');
    expect(mocks.getAIResponse).not.toHaveBeenCalled();

    // A third message arrives — threshold met, extraction runs.
    mocks.messageLog.push({ sender: 'c@s.whatsapp.net', text: 'Trivia is at Parlor.', timestamp: nowSeconds() });
    await maybeExtractCommunityFacts('chat@g.us', 'General');
    expect(mocks.getAIResponse).toHaveBeenCalledTimes(1);

    // More traffic inside the interval — still blocked by the interval.
    mocks.messageLog.push(
      { sender: 'a@s.whatsapp.net', text: 'Soup swap is in December.', timestamp: nowSeconds() + 1 },
      { sender: 'b@s.whatsapp.net', text: 'Mina runs the supply sheet.', timestamp: nowSeconds() + 2 },
      { sender: 'c@s.whatsapp.net', text: 'Welcome new folks!', timestamp: nowSeconds() + 3 },
    );
    await maybeExtractCommunityFacts('chat@g.us', 'General');
    expect(mocks.getAIResponse).toHaveBeenCalledTimes(1);

    // Interval passed AND fresh messages exist — extraction runs again.
    vi.setSystemTime(new Date('2026-07-02T13:01:00Z'));
    await maybeExtractCommunityFacts('chat@g.us', 'General');
    expect(mocks.getAIResponse).toHaveBeenCalledTimes(2);

    // Interval passes again but the group went quiet — nothing fresh, no call.
    vi.setSystemTime(new Date('2026-07-02T14:02:00Z'));
    await maybeExtractCommunityFacts('chat@g.us', 'General');
    expect(mocks.getAIResponse).toHaveBeenCalledTimes(2);
  });

  it('stores extracted facts with source auto', async () => {
    const mocks = mockDeps({
      aiResponse: '[{"category":"venues","fact":"Trivia regulars meet at Parlor on Wednesdays."}]',
    });
    const { maybeExtractCommunityFacts } = await import('../src/features/memory-extract.js');

    await maybeExtractCommunityFacts('chat@g.us', 'General');
    await maybeExtractCommunityFacts('chat@g.us', 'General');

    expect(mocks.addMemory).toHaveBeenCalledWith(
      'Trivia regulars meet at Parlor on Wednesdays.',
      'venues',
      'auto',
    );
  });

  it('parses JSON arrays returned in code fences', async () => {
    const mocks = mockDeps({
      aiResponse: [
        '```json',
        '[',
        '  {"category":"members","fact":"Mina maintains the mutual-aid supply spreadsheet."}',
        ']',
        '```',
      ].join('\n'),
    });
    const { maybeExtractCommunityFacts } = await import('../src/features/memory-extract.js');

    await maybeExtractCommunityFacts('chat@g.us', 'General');
    await maybeExtractCommunityFacts('chat@g.us', 'General');

    expect(mocks.addMemory).toHaveBeenCalledWith(
      'Mina maintains the mutual-aid supply spreadsheet.',
      'members',
      'auto',
    );
  });

  it('ignores malformed JSON without throwing or storing', async () => {
    const mocks = mockDeps({ aiResponse: 'not json' });
    const { maybeExtractCommunityFacts } = await import('../src/features/memory-extract.js');

    await expect(maybeExtractCommunityFacts('chat@g.us', 'General')).resolves.toBeUndefined();
    await expect(maybeExtractCommunityFacts('chat@g.us', 'General')).resolves.toBeUndefined();

    expect(mocks.addMemory).not.toHaveBeenCalled();
  });

  it('skips near-duplicate memories', async () => {
    const mocks = mockDeps({
      existingMemories: [{
        id: 7,
        fact: 'Trivia regulars meet at Parlor on Wednesdays.',
        category: 'venues',
        source: 'owner',
        created_at: 1,
      }],
      aiResponse: '[{"category":"venues","fact":"Trivia regulars meet at Parlor every Wednesday."}]',
    });
    const { maybeExtractCommunityFacts } = await import('../src/features/memory-extract.js');

    await maybeExtractCommunityFacts('chat@g.us', 'General');
    await maybeExtractCommunityFacts('chat@g.us', 'General');

    expect(mocks.addMemory).not.toHaveBeenCalled();
  });

  it('prunes the oldest auto facts down to the configured cap', async () => {
    const mocks = mockDeps({
      maxFacts: 2,
      existingMemories: [
        { id: 1, fact: 'Oldest auto fact.', category: 'general', source: 'auto', created_at: 100 },
        { id: 2, fact: 'Middle auto fact.', category: 'general', source: 'auto', created_at: 200 },
        { id: 3, fact: 'Manual owner fact.', category: 'general', source: 'owner', created_at: 50 },
      ],
      aiResponse: '[{"category":"traditions","fact":"The group does an annual winter soup swap."}]',
    });
    const { maybeExtractCommunityFacts } = await import('../src/features/memory-extract.js');

    await maybeExtractCommunityFacts('chat@g.us', 'General');
    await maybeExtractCommunityFacts('chat@g.us', 'General');

    expect(mocks.deleteMemory).toHaveBeenCalledWith(1);
    expect(mocks.memories.map((entry) => entry.id)).toEqual([2, 3, 4]);
  });

  it('skips a second concurrent extraction for the same chat', async () => {
    let releaseResponse: (value: string) => void = () => undefined;
    const aiResponse = new Promise<string>((resolve) => {
      releaseResponse = resolve;
    });
    const mocks = mockDeps({
      minMessages: 1,
      aiResponse,
    });
    const { maybeExtractCommunityFacts } = await import('../src/features/memory-extract.js');

    const first = maybeExtractCommunityFacts('chat@g.us', 'General');
    const second = maybeExtractCommunityFacts('chat@g.us', 'General');

    await Promise.resolve();
    expect(mocks.getAIResponse).toHaveBeenCalledTimes(1);
    releaseResponse('[{"category":"general","fact":"The group keeps a shared packing checklist."}]');
    await Promise.all([first, second]);

    expect(mocks.addMemory).toHaveBeenCalledTimes(1);
  });
});
