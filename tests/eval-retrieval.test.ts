import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVAL_SET,
  generateSyntheticData,
  runEvaluation,
} from '../src/utils/eval-retrieval.js';

describe('retrieval evaluation harness', () => {
  it('generates synthetic data matching all eval queries', () => {
    const { messages, sessions } = generateSyntheticData(DEFAULT_EVAL_SET);

    expect(messages.length).toBeGreaterThan(0);
    expect(sessions.length).toBeGreaterThan(0);

    // Each session should have required fields
    for (const session of sessions) {
      expect(session.sessionId).toBeGreaterThan(0);
      expect(session.summaryText.length).toBeGreaterThan(0);
      expect(session.participants.length).toBeGreaterThan(0);
      expect(session.startedAt).toBeLessThan(session.endedAt);
    }
  });

  it('achieves high recall on synthetic data with default eval set', () => {
    const { messages, sessions } = generateSyntheticData(DEFAULT_EVAL_SET);
    const summary = runEvaluation(DEFAULT_EVAL_SET, messages, sessions, 5);

    expect(summary.totalQueries).toBe(DEFAULT_EVAL_SET.length);

    // With synthetic data that exactly matches the eval set, mean recall
    // should be high (>= 0.7 is a reasonable baseline)
    expect(summary.meanRecallAtK).toBeGreaterThanOrEqual(0.7);

    // At least half the queries should have perfect recall
    expect(summary.perfectRecallCount).toBeGreaterThanOrEqual(
      Math.floor(DEFAULT_EVAL_SET.length / 2),
    );
  });

  it('reports noise detection for unexpected evidence', () => {
    const { messages, sessions } = generateSyntheticData(DEFAULT_EVAL_SET);
    const summary = runEvaluation(DEFAULT_EVAL_SET, messages, sessions, 5);

    // With well-separated synthetic data, noise should be minimal
    // Allow some noise since the reranker merges all candidates
    expect(summary.noiseCount).toBeLessThanOrEqual(
      Math.ceil(DEFAULT_EVAL_SET.length / 2),
    );
  });

  it('returns per-query result details', () => {
    const { messages, sessions } = generateSyntheticData(DEFAULT_EVAL_SET);
    const summary = runEvaluation(DEFAULT_EVAL_SET, messages, sessions, 3);

    for (const result of summary.results) {
      expect(result.label).toBeTruthy();
      expect(result.query).toBeTruthy();
      expect(result.evidenceTotal).toBeGreaterThan(0);
      expect(result.recallAtK).toBeGreaterThanOrEqual(0);
      expect(result.recallAtK).toBeLessThanOrEqual(1);
      expect(result.candidates.length).toBeLessThanOrEqual(3);

      for (const candidate of result.candidates) {
        expect(['message', 'session']).toContain(candidate.source);
        expect(typeof candidate.score).toBe('number');
        expect(candidate.textSnippet.length).toBeGreaterThan(0);
      }
    }
  });

  it('handles empty data gracefully', () => {
    const summary = runEvaluation(DEFAULT_EVAL_SET, [], [], 5);

    expect(summary.totalQueries).toBe(DEFAULT_EVAL_SET.length);
    expect(summary.meanRecallAtK).toBe(0);
    expect(summary.perfectRecallCount).toBe(0);

    for (const result of summary.results) {
      expect(result.candidates.length).toBe(0);
      expect(result.recallAtK).toBe(0);
    }
  });

  it('handles custom eval queries', () => {
    const customQueries = [
      {
        label: 'custom-test',
        query: 'What about the pizza party?',
        expectedEvidence: ['pizza', 'party'],
      },
    ];

    const messages = [
      { sender: 'alice', text: 'Let us plan a pizza party this weekend!', timestamp: Math.floor(Date.now() / 1000) - 600 },
    ];

    const summary = runEvaluation(customQueries, messages, [], 5);
    expect(summary.totalQueries).toBe(1);
    expect(summary.results[0].label).toBe('custom-test');
    expect(summary.results[0].evidenceHits).toBeGreaterThanOrEqual(1);
  });
});
