process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { describe, expect, it, vi } from 'vitest';
import { createInMemoryVectorStore, type VectorHit } from '../src/utils/vector-store.js';
import { rerankCandidates } from '../src/utils/reranker.js';
import { DEFAULT_EVAL_SET, generateSyntheticData } from '../src/utils/eval-retrieval.js';
import type { DbMessage, SessionSummaryHit } from '../src/utils/db-types.js';

/**
 * Recall@k regression guard for the Qdrant retrieval path.
 *
 * The existing tests/eval-retrieval.test.ts exercises the OLD retrieval path
 * (keyword message filter + scoreSessionMatch). This guards the NEW path:
 * index the same synthetic eval data through vector-memory into the in-memory
 * VectorStore, retrieve via searchMessages/searchSessions, rerank, and assert
 * mean recall@k does not fall below the same 0.7 baseline.
 *
 * The in-memory store ranks by cosine similarity, so a random-hash embedding
 * would retrieve nothing useful. We inject a deterministic *token-bag*
 * embedding: each token sets a hashed dimension, so texts that share tokens
 * have high cosine similarity. This is stable across runs and lets lexical
 * overlap drive retrieval the way real semantic embeddings would for these
 * keyword-heavy eval queries.
 */

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((t) => t.length >= 3);
}

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function tokenBagEmbedding(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokenize(text)) {
    vector[hashToken(token) % dimensions] += 1;
  }
  return vector;
}

async function loadVectorMemoryWithTokenEmbedding() {
  vi.resetModules();
  vi.doMock('../src/utils/embedding-provider.js', () => ({
    embedTextForVectorSearch: vi.fn(async (text: string, dimensions: number) => ({
      vector: tokenBagEmbedding(text, dimensions),
      provider: 'deterministic' as const,
      model: 'token-bag-test',
      latencyMs: 0,
      usedFallback: false,
    })),
  }));
  return import('../src/utils/vector-memory.js');
}

function messageHitToDbMessage(hit: VectorHit): DbMessage {
  return {
    sender: String(hit.payload.extra?.sender ?? ''),
    text: hit.payload.text,
    timestamp: hit.payload.createdAt,
  };
}

function sessionHitToSummary(hit: VectorHit): SessionSummaryHit {
  const extra = hit.payload.extra ?? {};
  const timeRange = Array.isArray(extra.timeRange) ? extra.timeRange : [];
  return {
    sessionId: Number(hit.payload.refId),
    startedAt: typeof timeRange[0] === 'number' ? timeRange[0] : hit.payload.createdAt,
    endedAt: typeof timeRange[1] === 'number' ? timeRange[1] : hit.payload.createdAt,
    messageCount: typeof extra.messageCount === 'number' ? extra.messageCount : 0,
    participants: Array.isArray(extra.participants)
      ? extra.participants.filter((p): p is string => typeof p === 'string')
      : [],
    topicTags: Array.isArray(extra.topics)
      ? extra.topics.filter((t): t is string => typeof t === 'string')
      : [],
    summaryText: hit.payload.text,
    score: hit.score,
  };
}

describe('vector retrieval recall@k guard', () => {
  it('keeps mean recall@k at or above the 0.7 baseline through the Qdrant path', async () => {
    const mod = await loadVectorMemoryWithTokenEmbedding();
    const store = createInMemoryVectorStore();
    mod.__setVectorStoreForTests(store);

    const { messages, sessions } = generateSyntheticData(DEFAULT_EVAL_SET);
    const chatJid = 'eval@g.us';
    const topK = 5;

    // Index the synthetic evidence through the same ingest functions production uses.
    for (const message of messages) {
      await mod.indexMessage({
        chatJid,
        refId: `${message.timestamp}:${message.sender}`,
        sender: message.sender,
        text: message.text,
        createdAt: message.timestamp,
      });
    }
    for (const session of sessions) {
      await mod.indexSession({
        chatJid,
        refId: String(session.sessionId),
        embeddingInput: session.summaryText,
        summaryText: session.summaryText,
        createdAt: session.endedAt,
        extra: {
          topics: session.topicTags,
          timeRange: [session.startedAt, session.endedAt],
          messageCount: session.messageCount,
          participants: session.participants,
        },
      });
    }

    let recallSum = 0;
    for (const evalQuery of DEFAULT_EVAL_SET) {
      const messageHits = await mod.searchMessages(chatJid, evalQuery.query, topK);
      const sessionHits = await mod.searchSessions(chatJid, evalQuery.query, topK);

      const ranked = rerankCandidates(
        messageHits.map(messageHitToDbMessage),
        sessionHits.map(sessionHitToSummary),
        evalQuery.query,
        topK,
      );

      const candidateText = ranked.map((c) => c.text.toLowerCase()).join(' ');
      const hits = evalQuery.expectedEvidence.filter((token) =>
        candidateText.includes(token.toLowerCase()),
      ).length;
      recallSum += evalQuery.expectedEvidence.length > 0
        ? hits / evalQuery.expectedEvidence.length
        : 1;
    }

    const meanRecallAtK = recallSum / DEFAULT_EVAL_SET.length;
    expect(meanRecallAtK).toBeGreaterThanOrEqual(0.7);
  });
});
