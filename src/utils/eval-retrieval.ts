/**
 * Offline retrieval evaluation harness.
 *
 * Defines a set of test queries with expected evidence tokens, runs the
 * retrieval pipeline (session summaries + message search + reranker),
 * and reports recall@K metrics.
 *
 * This is designed to run as a test or CLI script against either real
 * or mock data. The eval set captures history-dependent questions that
 * exercise the full session memory pipeline.
 */

import { rerankCandidates } from './reranker.js';
import { scoreSessionMatch } from './session-summary.js';
import type { DbMessage, SessionSummaryHit } from './db-types.js';

// ── Eval types ──────────────────────────────────────────────────────

export interface EvalQuery {
  /** Human-readable label for the test case */
  label: string;
  /** The user query to evaluate */
  query: string;
  /** Tokens/phrases that MUST appear in at least one retrieved candidate */
  expectedEvidence: string[];
  /** Optional: tokens that should NOT appear (noise check) */
  unexpectedEvidence?: string[];
}

export interface EvalResult {
  label: string;
  query: string;
  /** Number of expected evidence tokens found in top-K candidates */
  evidenceHits: number;
  /** Total expected evidence tokens */
  evidenceTotal: number;
  /** recall@K = evidenceHits / evidenceTotal */
  recallAtK: number;
  /** Whether any unexpected evidence was found (false = clean) */
  noiseDetected: boolean;
  /** The top-K candidates returned by the reranker */
  candidates: Array<{ source: string; score: number; textSnippet: string }>;
}

export interface EvalSummary {
  totalQueries: number;
  meanRecallAtK: number;
  perfectRecallCount: number;
  noiseCount: number;
  results: EvalResult[];
}

// ── Default eval set ────────────────────────────────────────────────

/**
 * Synthetic QA set for evaluating group chat memory retrieval.
 * These simulate the kinds of follow-up questions that test
 * whether the bot can recall earlier conversations.
 */
export const DEFAULT_EVAL_SET: EvalQuery[] = [
  {
    label: 'trivia-event-recall',
    query: 'When is the next trivia night?',
    expectedEvidence: ['trivia', 'wednesday', 'cambridge'],
    unexpectedEvidence: ['gardening', 'recipes'],
  },
  {
    label: 'restaurant-recommendation',
    query: 'What restaurant did people recommend in Somerville?',
    expectedEvidence: ['restaurant', 'somerville'],
    unexpectedEvidence: ['trivia'],
  },
  {
    label: 'transit-discussion',
    query: 'Were there any MBTA delays discussed?',
    expectedEvidence: ['mbta', 'delay', 'red'],
  },
  {
    label: 'planning-decision',
    query: 'What was decided about the Saturday meetup?',
    expectedEvidence: ['saturday', 'meetup', 'decided'],
  },
  {
    label: 'person-reference',
    query: 'What did Alice suggest about the venue?',
    expectedEvidence: ['alice', 'venue'],
  },
  {
    label: 'topic-switch',
    query: 'Did anyone talk about hiking trails recently?',
    expectedEvidence: ['hiking', 'trail'],
    unexpectedEvidence: ['trivia', 'restaurant'],
  },
];

// ── Synthetic data generator ────────────────────────────────────────

/**
 * Generate synthetic messages and session summaries that contain the
 * evidence tokens from the eval set. This allows running the eval
 * harness without a real database.
 */
export function generateSyntheticData(_evalSet: EvalQuery[]): {
  messages: DbMessage[];
  sessions: SessionSummaryHit[];
} {
  const now = Math.floor(Date.now() / 1000);
  const messages: DbMessage[] = [];
  const sessions: SessionSummaryHit[] = [];

  // Generate matching data for each eval query
  const syntheticConversations: Array<{
    participants: string[];
    messages: Array<{ sender: string; text: string }>;
    topicTags: string[];
  }> = [
    {
      participants: ['alice', 'bob', 'charlie'],
      messages: [
        { sender: 'alice', text: 'Can we do trivia in Cambridge on Wednesday at 7 PM?' },
        { sender: 'bob', text: 'Sounds good. Red line MBTA delays might matter though.' },
        { sender: 'charlie', text: 'I know a great venue in Cambridge for trivia.' },
        { sender: 'alice', text: 'Let me check the venue availability for Wednesday.' },
      ],
      topicTags: ['trivia', 'cambridge', 'wednesday', 'venue'],
    },
    {
      participants: ['dave', 'emma', 'frank'],
      messages: [
        { sender: 'dave', text: 'Anyone know a good restaurant in Somerville?' },
        { sender: 'emma', text: 'I recommend the new place on Highland Ave in Somerville.' },
        { sender: 'frank', text: 'Great restaurant recommendation, I second that.' },
      ],
      topicTags: ['restaurant', 'somerville', 'food'],
    },
    {
      participants: ['alice', 'george'],
      messages: [
        { sender: 'george', text: 'The MBTA red line had major delay this morning.' },
        { sender: 'alice', text: 'Yeah the red line delay was 20 minutes.' },
      ],
      topicTags: ['mbta', 'delay', 'red', 'transit'],
    },
    {
      participants: ['bob', 'charlie', 'dave'],
      messages: [
        { sender: 'bob', text: 'For the Saturday meetup, I think we decided on the park.' },
        { sender: 'charlie', text: 'Confirmed — the Saturday meetup is decided for the park at 2 PM.' },
        { sender: 'dave', text: 'Count me in for the Saturday meetup.' },
      ],
      topicTags: ['saturday', 'meetup', 'decided', 'park'],
    },
    {
      participants: ['alice', 'emma'],
      messages: [
        { sender: 'alice', text: 'I found some great hiking trails near Blue Hills.' },
        { sender: 'emma', text: 'Those hiking trail options look amazing.' },
      ],
      topicTags: ['hiking', 'trail', 'outdoors'],
    },
  ];

  let sessionId = 1;
  for (let i = 0; i < syntheticConversations.length; i++) {
    const conv = syntheticConversations[i];
    const sessionStart = now - (syntheticConversations.length - i) * 7200;
    const sessionEnd = sessionStart + conv.messages.length * 120;

    // Add individual messages
    for (let j = 0; j < conv.messages.length; j++) {
      messages.push({
        sender: conv.messages[j].sender,
        text: conv.messages[j].text,
        timestamp: sessionStart + j * 120,
      });
    }

    // Build session summary
    const summaryLines = conv.messages
      .map((m) => `${m.sender}: ${m.text}`)
      .join(' | ');
    const summaryText = `Participants: ${conv.participants.join(', ')}. Topics: ${conv.topicTags.join(', ')}. ${summaryLines}`;

    sessions.push({
      sessionId,
      startedAt: sessionStart,
      endedAt: sessionEnd,
      messageCount: conv.messages.length,
      participants: conv.participants,
      topicTags: conv.topicTags,
      summaryText,
      score: 0, // Will be computed during evaluation
    });

    sessionId++;
  }

  return { messages, sessions };
}

// ── Evaluation runner ───────────────────────────────────────────────

/**
 * Run the evaluation harness against provided data.
 *
 * For each query in the eval set:
 * 1. Score session summaries with `scoreSessionMatch`
 * 2. Run the reranker on messages + scored sessions
 * 3. Check how many expected evidence tokens appear in top-K candidates
 * 4. Report recall@K and noise detection
 */
export function runEvaluation(
  evalSet: EvalQuery[],
  messages: DbMessage[],
  sessions: SessionSummaryHit[],
  topK: number = 5,
): EvalSummary {
  const results: EvalResult[] = [];

  for (const evalQuery of evalSet) {
    // Score sessions for this query
    const scoredSessions = sessions.map((s) => ({
      ...s,
      score: scoreSessionMatch(s.summaryText, s.topicTags, evalQuery.query, s.endedAt),
    }));

    // Filter to sessions with positive scores
    const relevantSessions = scoredSessions
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    // Simple keyword filter for messages (simulates what the DB would return)
    const queryTokens = new Set(
      evalQuery.query.toLowerCase().match(/[a-z0-9']+/g)?.filter((t) => t.length >= 3) ?? [],
    );
    const relevantMessages = messages
      .filter((m) => {
        const lower = m.text.toLowerCase();
        return [...queryTokens].some((t) => lower.includes(t));
      })
      .slice(0, topK);

    // Run reranker
    const ranked = rerankCandidates(
      relevantMessages,
      relevantSessions,
      evalQuery.query,
      topK,
    );

    // Check evidence in top-K candidates
    const allCandidateText = ranked
      .map((c) => c.text.toLowerCase())
      .join(' ');

    let evidenceHits = 0;
    for (const token of evalQuery.expectedEvidence) {
      if (allCandidateText.includes(token.toLowerCase())) {
        evidenceHits += 1;
      }
    }

    let noiseDetected = false;
    if (evalQuery.unexpectedEvidence) {
      for (const token of evalQuery.unexpectedEvidence) {
        if (allCandidateText.includes(token.toLowerCase())) {
          noiseDetected = true;
          break;
        }
      }
    }

    results.push({
      label: evalQuery.label,
      query: evalQuery.query,
      evidenceHits,
      evidenceTotal: evalQuery.expectedEvidence.length,
      recallAtK: evalQuery.expectedEvidence.length > 0
        ? evidenceHits / evalQuery.expectedEvidence.length
        : 1,
      noiseDetected,
      candidates: ranked.map((c) => ({
        source: c.source,
        score: Math.round(c.score * 1000) / 1000,
        textSnippet: c.text.length > 120 ? `${c.text.slice(0, 117)}...` : c.text,
      })),
    });
  }

  const totalQueries = results.length;
  const meanRecallAtK = totalQueries > 0
    ? results.reduce((sum, r) => sum + r.recallAtK, 0) / totalQueries
    : 0;
  const perfectRecallCount = results.filter((r) => r.recallAtK === 1).length;
  const noiseCount = results.filter((r) => r.noiseDetected).length;

  return {
    totalQueries,
    meanRecallAtK: Math.round(meanRecallAtK * 1000) / 1000,
    perfectRecallCount,
    noiseCount,
    results,
  };
}
