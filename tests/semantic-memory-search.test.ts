process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbBackend } from '../src/utils/db-backend.js';
import type { MemoryEntry } from '../src/utils/db-types.js';
import type { VectorHit } from '../src/utils/vector-store.js';

const semanticHit: VectorHit = {
  id: 'fact:3',
  score: 0.8,
  payload: {
    kind: 'fact',
    scope: 'global',
    chatJid: null,
    refId: '3',
    text: 'Trivia night is Wednesdays at Parlor',
    createdAt: 0,
    extra: { category: 'venues' },
  },
};

const searchFacts = vi.fn<(query: string, limit: number) => Promise<VectorHit[]>>();
const keywordSearchMemory = vi.fn<(keyword: string, limit?: number) => Promise<MemoryEntry[]>>();

function createBackend(): DbBackend {
  return {
    touchProfile: vi.fn(async () => undefined),
    getProfile: vi.fn(async () => undefined),
    setProfileInterests: vi.fn(async () => undefined),
    setProfileName: vi.fn(async () => undefined),
    updateActiveGroups: vi.fn(async () => undefined),
    getOptedInProfiles: vi.fn(async () => []),
    deleteProfileData: vi.fn(async () => undefined),
    backupDatabase: vi.fn(async () => ''),
    runMaintenance: vi.fn(async () => ({ pruned: 0, beforeCount: 0, afterCount: 0 })),
    verifyLatestBackupIntegrity: vi.fn(async () => ({
      available: false,
      path: null,
      modifiedAt: null,
      ageHours: null,
      sizeBytes: null,
      integrityOk: null,
      message: '',
    })),
    scheduleMaintenance: vi.fn(() => undefined),
    stopMaintenance: vi.fn(() => undefined),
    storeMessage: vi.fn(async () => 1),
    getMessages: vi.fn(async () => []),
    searchRelevantMessages: vi.fn(async () => []),
    searchRelevantSessionSummaries: vi.fn(async () => []),
    logModeration: vi.fn(async () => undefined),
    getStrikeCount: vi.fn(async () => 0),
    getRepeatOffenders: vi.fn(async () => []),
    saveDailyStats: vi.fn(async () => undefined),
    loadDailyStatsRange: vi.fn(async () => []),
    getDailyGroupActivity: vi.fn(async () => []),
    addEventReminder: vi.fn(async (input) => ({
      ...input,
      id: 1,
      status: 'pending',
      createdAt: 0,
    })),
    listPendingEventReminders: vi.fn(async () => []),
    listUpcomingEventReminders: vi.fn(async () => []),
    markEventReminderSent: vi.fn(async () => false),
    cancelEventReminder: vi.fn(async () => false),
    createWhatsAppOutboundJob: vi.fn(async (chatJid, kind, contentJson, optionsJson) => ({
      id: 1,
      chatJid,
      kind,
      contentJson,
      optionsJson,
      status: 'pending',
      reason: null,
      attempts: 0,
      createdAt: 0,
      updatedAt: 0,
      sentAt: null,
    })),
    updateWhatsAppOutboundJob: vi.fn(async () => false),
    getWhatsAppOutboundJob: vi.fn(async () => undefined),
    listWhatsAppHeldJobs: vi.fn(async () => []),
    recoverWhatsAppPendingJobs: vi.fn(async () => 0),
    countWhatsAppSentSince: vi.fn(async () => 0),
    getWhatsAppSafetyState: vi.fn(async () => ({
      paused: false,
      risk: 'low',
      score: 0,
      reasons: [],
      updatedAt: 0,
    })),
    setWhatsAppSafetyState: vi.fn(async () => undefined),
    getWhatsAppSafetyMetrics: vi.fn(async () => ({
      pending: 0,
      held: 0,
      sentLastHour: 0,
      sentLastDay: 0,
      failedLastHour: 0,
      paused: false,
      risk: 'low',
      score: 0,
    })),
    submitFeedback: vi.fn(async (type, sender, groupJid, text) => ({
      id: 1,
      type,
      sender,
      group_jid: groupJid,
      text,
      status: 'open',
      upvotes: 0,
      upvoters: '[]',
      github_issue_number: null,
      github_issue_url: null,
      github_issue_created_at: null,
      timestamp: 0,
    })),
    getOpenFeedback: vi.fn(async () => []),
    getRecentFeedback: vi.fn(async () => []),
    getFeedbackById: vi.fn(async () => undefined),
    setFeedbackStatus: vi.fn(async () => false),
    upvoteFeedback: vi.fn(async () => false),
    linkFeedbackToGitHubIssue: vi.fn(async () => false),
    addMemory: vi.fn(async (fact, category = 'general', source = 'owner') => ({
      id: 1,
      fact,
      category,
      source,
      created_at: 0,
    })),
    getAllMemories: vi.fn(async () => []),
    deleteMemory: vi.fn(async () => false),
    searchMemory: keywordSearchMemory,
    formatMemoriesForPrompt: vi.fn(async () => ''),
    closeDb: vi.fn(async () => undefined),
  };
}

async function loadDb() {
  vi.resetModules();
  vi.doMock('../src/utils/vector-memory.js', () => ({
    searchFacts,
    indexFact: vi.fn(async () => undefined),
    deleteFact: vi.fn(async () => undefined),
  }));
  vi.doMock('../src/utils/db-sqlite.js', () => ({
    createSqliteBackend: () => createBackend(),
  }));
  return import('../src/utils/db.js');
}

describe('semantic memory search', () => {
  beforeEach(() => {
    searchFacts.mockReset();
    keywordSearchMemory.mockReset();
  });

  it('returns semantic fact hits mapped to MemoryEntry when available', async () => {
    searchFacts.mockResolvedValueOnce([semanticHit]);
    keywordSearchMemory.mockResolvedValueOnce([]);

    const db = await loadDb();
    const results = await db.searchMemory('board game night', 4);

    expect(searchFacts).toHaveBeenCalledWith('board game night', 4);
    expect(keywordSearchMemory).not.toHaveBeenCalled();
    expect(results).toEqual([
      {
        id: 3,
        fact: 'Trivia night is Wednesdays at Parlor',
        category: 'venues',
        source: 'auto',
        created_at: 0,
      },
    ]);
  });

  it('falls back to keyword search when semantic search returns no hits', async () => {
    const keywordResult = [{
      id: 7,
      fact: 'Board games happen monthly',
      category: 'events',
      source: 'owner',
      created_at: 10,
    }];
    searchFacts.mockResolvedValueOnce([]);
    keywordSearchMemory.mockResolvedValueOnce(keywordResult);

    const db = await loadDb();
    const results = await db.searchMemory('board games', 2);

    expect(searchFacts).toHaveBeenCalledWith('board games', 2);
    expect(keywordSearchMemory).toHaveBeenCalledWith('board games', 2);
    expect(results).toBe(keywordResult);
  });
});
