process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.AI_TOOL_CALLING ??= 'true';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalMemoryEntry } from '../src/utils/db-types.js';

const dbMocks = vi.hoisted(() => ({
  addMemory: vi.fn(),
  deleteMemory: vi.fn(),
  getAllMemories: vi.fn(),
  getMessages: vi.fn(),
  searchMemory: vi.fn(),
}));

vi.mock('../src/utils/db.js', () => dbMocks);

import { getEnabledTools, type AiTool } from '../src/ai/tools.js';
import { config } from '../src/utils/config.js';

function makeEntry(overrides: Partial<LocalMemoryEntry> = {}): LocalMemoryEntry {
  return {
    id: 7,
    fact: 'Anna hosts the monthly board-game night',
    category: 'members',
    source: 'ai-tool',
    created_at: 0,
    ...overrides,
  };
}

function saveTool(): AiTool {
  const tool = getEnabledTools().find((t) => t.name === 'save_community_memory');
  if (!tool) throw new Error('save_community_memory tool not registered');
  return tool;
}

describe('save_community_memory tool', () => {
  let originalToolCalling: boolean;

  beforeEach(() => {
    originalToolCalling = config.AI_TOOL_CALLING;
    config.AI_TOOL_CALLING = true;
    vi.clearAllMocks();
    dbMocks.searchMemory.mockResolvedValue([]);
    dbMocks.addMemory.mockResolvedValue(makeEntry());
    dbMocks.getAllMemories.mockResolvedValue([]);
  });

  afterEach(() => {
    config.AI_TOOL_CALLING = originalToolCalling;
  });

  it('is registered and enabled without any feature flag', () => {
    const names = getEnabledTools().map((t) => t.name);
    expect(names).toContain('save_community_memory');
    expect(names).toContain('search_community_memory');
  });

  it('saves a valid fact with ai-tool provenance and reports the id', async () => {
    const result = await saveTool().execute({
      fact: 'Anna hosts the monthly board-game night',
      category: 'members',
    });

    expect(dbMocks.addMemory).toHaveBeenCalledWith(
      'Anna hosts the monthly board-game night',
      'members',
      'ai-tool',
    );
    expect(result).toContain('#7');
    expect(result).toContain('Saved to community memory');
  });

  it('normalizes an unknown category to general', async () => {
    await saveTool().execute({
      fact: 'The group meets at the Somerville library',
      category: 'nonsense-category',
    });

    expect(dbMocks.addMemory).toHaveBeenCalledWith(
      'The group meets at the Somerville library',
      'general',
      'ai-tool',
    );
  });

  it('rejects a missing fact without touching the database', async () => {
    const result = await saveTool().execute({});

    expect(result).toContain('needs a non-empty fact');
    expect(dbMocks.addMemory).not.toHaveBeenCalled();
    expect(dbMocks.searchMemory).not.toHaveBeenCalled();
  });

  it('rejects a too-short fact without touching the database', async () => {
    const result = await saveTool().execute({ fact: 'too short' });

    expect(result).toContain('Memory not saved');
    expect(result).toContain('15-140');
    expect(dbMocks.addMemory).not.toHaveBeenCalled();
  });

  it('rejects an over-long fact without touching the database', async () => {
    const result = await saveTool().execute({ fact: 'x'.repeat(200) });

    expect(result).toContain('Memory not saved');
    expect(dbMocks.addMemory).not.toHaveBeenCalled();
  });

  it('skips a duplicate fact instead of saving it', async () => {
    dbMocks.searchMemory.mockResolvedValue([
      makeEntry({ id: 3, fact: 'Anna hosts the monthly board-game night', source: 'owner' }),
    ]);

    const result = await saveTool().execute({
      fact: 'Anna hosts the monthly board-game night',
    });

    expect(result).toContain('already in community memory');
    expect(dbMocks.addMemory).not.toHaveBeenCalled();
  });

  it('prunes machine-written facts beyond the cap after a save', async () => {
    const originalCap = config.MEMORY_AUTO_MAX_FACTS;
    config.MEMORY_AUTO_MAX_FACTS = 2;
    try {
      dbMocks.getAllMemories.mockResolvedValue([
        makeEntry({ id: 1, source: 'auto', created_at: 100 }),
        makeEntry({ id: 2, source: 'ai-tool', created_at: 200 }),
        makeEntry({ id: 3, source: 'owner', created_at: 50 }),
        makeEntry({ id: 4, source: 'ai-tool', created_at: 300 }),
      ]);

      await saveTool().execute({ fact: 'The group meets at the Somerville library' });

      // Oldest machine-written fact goes; owner facts are never pruned.
      expect(dbMocks.deleteMemory).toHaveBeenCalledTimes(1);
      expect(dbMocks.deleteMemory).toHaveBeenCalledWith(1);
    } finally {
      config.MEMORY_AUTO_MAX_FACTS = originalCap;
    }
  });

  it('reports failure when the database write throws', async () => {
    dbMocks.addMemory.mockRejectedValue(new Error('disk full'));

    const result = await saveTool().execute({
      fact: 'The group meets at the Somerville library',
    });

    expect(result).toContain('save_community_memory failed');
    expect(result).toContain('disk full');
  });
});

describe('save_community_memory rate limiting', () => {
  it('blocks attempts past the per-window limit', async () => {
    // Fresh module so limiter state from other suites cannot interfere.
    vi.resetModules();
    vi.clearAllMocks();
    const { getEnabledTools: freshGetEnabledTools } = await import('../src/ai/tools.js');
    const tool = freshGetEnabledTools().find((t) => t.name === 'save_community_memory');
    if (!tool) throw new Error('save_community_memory tool not registered');

    dbMocks.searchMemory.mockResolvedValue([]);
    dbMocks.getAllMemories.mockResolvedValue([]);
    dbMocks.addMemory.mockImplementation((fact: string) =>
      Promise.resolve(makeEntry({ fact })),
    );

    for (let i = 0; i < 5; i += 1) {
      const result = await tool.execute({ fact: `Distinct community fact number ${i} zz${i}` });
      expect(result).toContain('Saved to community memory');
    }

    const blocked = await tool.execute({ fact: 'One more community fact beyond the cap' });
    expect(blocked).toContain('save limit');
    expect(dbMocks.addMemory).toHaveBeenCalledTimes(5);
  });
});
