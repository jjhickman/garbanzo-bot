import { describe, expect, it } from 'vitest';
import { summarizeSession, scoreSessionMatch, buildContextualizedEmbeddingInput } from '../src/utils/session-summary.js';

describe('session summary utilities', () => {
  it('builds summary text and topic tags from message window', () => {
    const now = Math.floor(Date.now() / 1000);
    const summary = summarizeSession(
      [
        { sender: 'alice', text: 'Can we do trivia in Cambridge on Wednesday at 7 PM?', timestamp: now - 120 },
        { sender: 'bob', text: 'Sounds good. Red line delays might matter though.', timestamp: now - 90 },
        { sender: 'alice', text: 'Let us lock venue by tomorrow morning.', timestamp: now - 60 },
      ],
      ['alice', 'bob'],
    );

    expect(summary.summaryText).toContain('Participants: alice, bob');
    expect(summary.summaryText.toLowerCase()).toContain('trivia');
    expect(summary.topicTags.length).toBeGreaterThan(0);
  });

  it('scores semantically matched recent sessions higher than stale misses', () => {
    const now = Math.floor(Date.now() / 1000);
    const highScore = scoreSessionMatch(
      'Participants discussed trivia plans in Cambridge and Red line timing.',
      ['trivia', 'cambridge', 'red'],
      'Any trivia plans in Cambridge tonight?',
      now - 900,
    );

    const lowScore = scoreSessionMatch(
      'Participants discussed recipes and gardening.',
      ['recipes', 'gardening'],
      'Any trivia plans in Cambridge tonight?',
      now - (10 * 24 * 3600),
    );

    expect(highScore).toBeGreaterThan(lowScore);
  });
});

describe('buildContextualizedEmbeddingInput', () => {
  it('prepends metadata header to summary text', () => {
    const result = buildContextualizedEmbeddingInput(
      'Discussed trivia plans in Cambridge.',
      {
        chatJid: 'group123@g.us',
        startedAt: 1700000000,
        endedAt: 1700003600,
        participants: ['alice', 'bob'],
        topicTags: ['trivia', 'cambridge'],
      },
    );

    expect(result).toContain('group: group123@g.us');
    expect(result).toContain('participants: alice, bob');
    expect(result).toContain('topics: trivia, cambridge');
    expect(result).toContain('time:');
    expect(result).toContain('Discussed trivia plans in Cambridge.');
    // Header should come before the summary
    const headerEnd = result.indexOf('\n');
    expect(headerEnd).toBeGreaterThan(0);
    expect(result.slice(headerEnd + 1)).toBe('Discussed trivia plans in Cambridge.');
  });

  it('returns plain summary when no metadata is provided', () => {
    const result = buildContextualizedEmbeddingInput('Just a plain summary.');
    expect(result).toBe('Just a plain summary.');
  });

  it('limits participants to 8', () => {
    const manyParticipants = Array.from({ length: 12 }, (_, i) => `user${i}`);
    const result = buildContextualizedEmbeddingInput('Summary text.', {
      participants: manyParticipants,
    });

    const participantSection = result.split('\n')[0];
    // Should contain user0 through user7 but not user8+
    expect(participantSection).toContain('user7');
    expect(participantSection).not.toContain('user8');
  });
});
