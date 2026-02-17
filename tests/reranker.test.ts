import { describe, expect, it } from 'vitest';
import { rerankCandidates } from '../src/utils/reranker.js';
import type { DbMessage, SessionSummaryHit } from '../src/utils/db-types.js';

const now = Math.floor(Date.now() / 1000);

function makeMessage(sender: string, text: string, ageSeconds: number = 600): DbMessage {
  return { sender, text, timestamp: now - ageSeconds };
}

function makeSession(
  id: number,
  summaryText: string,
  topicTags: string[],
  ageSeconds: number = 3600,
  score: number = 5,
): SessionSummaryHit {
  return {
    sessionId: id,
    startedAt: now - ageSeconds - 1800,
    endedAt: now - ageSeconds,
    messageCount: 8,
    participants: ['alice', 'bob'],
    topicTags,
    summaryText,
    score,
  };
}

describe('reranker', () => {
  it('returns empty array when no candidates', () => {
    const result = rerankCandidates([], [], 'test query', 5);
    expect(result).toEqual([]);
  });

  it('ranks messages only when no sessions provided', () => {
    const messages = [
      makeMessage('alice', 'Boston trivia night is Wednesday'),
      makeMessage('bob', 'I like gardening and recipes'),
    ];
    const result = rerankCandidates(messages, [], 'trivia night', 5);

    expect(result.length).toBe(2);
    expect(result.every((r) => r.source === 'message')).toBe(true);
    // The trivia message should rank higher due to token overlap
    expect(result[0].text).toContain('trivia');
  });

  it('ranks sessions only when no messages provided', () => {
    const sessions = [
      makeSession(1, 'Discussed trivia plans in Cambridge and Red line timing.', ['trivia', 'cambridge'], 900, 8),
      makeSession(2, 'Discussed gardening and plant care tips.', ['gardening', 'plants'], 7200, 2),
    ];
    const result = rerankCandidates([], sessions, 'trivia cambridge', 5);

    expect(result.length).toBe(2);
    expect(result.every((r) => r.source === 'session')).toBe(true);
    expect(result[0].text).toContain('trivia');
  });

  it('merges and ranks message + session candidates together', () => {
    const messages = [
      makeMessage('alice', 'What time is trivia in Cambridge?', 300),
      makeMessage('bob', 'I was looking at the gardening schedule.', 600),
    ];
    const sessions = [
      makeSession(1, 'Participants discussed trivia plans in Cambridge.', ['trivia', 'cambridge'], 3600, 9),
    ];

    const result = rerankCandidates(messages, sessions, 'trivia cambridge', 5);

    expect(result.length).toBe(3);
    // Session and trivia message should both appear
    const sources = result.map((r) => r.source);
    expect(sources).toContain('session');
    expect(sources).toContain('message');
  });

  it('respects limit parameter', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMessage('user', `Message number ${i} about trivia`, i * 100),
    );
    const result = rerankCandidates(messages, [], 'trivia', 3);
    expect(result.length).toBe(3);
  });

  it('demotes messages covered by session time windows', () => {
    const sessionStart = now - 3600;
    const sessionEnd = now - 1800;

    const messages = [
      // This message falls within the session window
      { sender: 'alice', text: 'trivia plans for Wednesday', timestamp: sessionStart + 300 },
      // This message is outside any session window
      { sender: 'bob', text: 'trivia at the pub next week', timestamp: now - 600 },
    ];

    const sessions: SessionSummaryHit[] = [{
      sessionId: 1,
      startedAt: sessionStart,
      endedAt: sessionEnd,
      messageCount: 8,
      participants: ['alice', 'bob'],
      topicTags: ['trivia'],
      summaryText: 'Discussed trivia plans for Wednesday at Cambridge pub.',
      score: 6,
    }];

    const result = rerankCandidates(messages, sessions, 'trivia wednesday', 5);

    // Bob's message (outside session) should rank higher than Alice's (inside session)
    const messageResults = result.filter((r) => r.source === 'message');
    if (messageResults.length >= 2) {
      const bobIdx = result.findIndex((r) => r.attribution === 'bob');
      const aliceIdx = result.findIndex((r) => r.attribution === 'alice');
      expect(bobIdx).toBeLessThan(aliceIdx);
    }
  });

  it('assigns correct source types', () => {
    const messages = [makeMessage('alice', 'test message')];
    const sessions = [makeSession(1, 'test session summary', ['test'])];

    const result = rerankCandidates(messages, sessions, 'test', 5);

    const messageCandidate = result.find((r) => r.source === 'message');
    const sessionCandidate = result.find((r) => r.source === 'session');

    expect(messageCandidate).toBeDefined();
    expect(sessionCandidate).toBeDefined();
    expect(messageCandidate?.attribution).toBe('alice');
    expect(sessionCandidate?.attribution).toContain('alice');
  });
});
