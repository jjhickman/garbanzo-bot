import { describe, expect, it } from 'vitest';

import {
  mapDailyGroupActivity,
  mapDbMessage,
  mapEventReminder,
  mapFeedbackEntry,
  mapMemoryEntry,
  mapMemberProfile,
  mapSessionSummaryHit,
  mapStrikeSummary,
  mapWhatsAppOutboundJob,
  mapWhatsAppSafetyState,
} from '../src/utils/db-mappers.js';
import {
  appendUniqueJsonArrayItem,
  extractSearchTerms,
  formatMemoriesForPromptEntries,
  mapWhatsAppSafetyMetrics,
  parseJsonArray,
  toBareJid,
  toJsonArrayString,
} from '../src/utils/db-query-shape.js';

describe('database shared query shaping', () => {
  it('round-trips JSON array serialization and tolerates malformed values', () => {
    expect(parseJsonArray('["hiking","trivia",42,null]')).toEqual(['hiking', 'trivia']);
    expect(parseJsonArray(['events', 7, 'venues'])).toEqual(['events', 'venues']);
    expect(parseJsonArray('not-json')).toEqual([]);
    expect(parseJsonArray(null)).toEqual([]);
    expect(toJsonArrayString('["events","venues"]')).toBe('["events","venues"]');
    expect(toJsonArrayString('not-json')).toBe('[]');
  });

  it('shapes repeated pure query values without changing backend behavior', () => {
    expect(toBareJid('15550000001:12@s.whatsapp.net')).toBe('15550000001');
    expect(appendUniqueJsonArrayItem('["a","b"]', 'b')).toBe('["a","b"]');
    expect(appendUniqueJsonArrayItem('["a","b"]', 'c')).toBe('["a","b","c"]');
    expect(appendUniqueJsonArrayItem('bad-json', 'c')).toBe('["c"]');
    expect(extractSearchTerms('Trivia trivia in Cambridge and Somerville', 4)).toEqual([
      'trivia',
      'cambridge',
      'and',
    ]);
  });

  it('formats memories for prompts from typed entries', () => {
    expect(formatMemoriesForPromptEntries([])).toBe('');
    expect(formatMemoriesForPromptEntries([
      { id: 1, fact: 'Trivia is on Wednesdays', category: 'events', source: 'owner', created_at: 10 },
      { id: 2, fact: 'Preferred venue is in Cambridge', category: 'venues', source: 'owner', created_at: 9 },
      { id: 3, fact: 'Board games run monthly', category: 'events', source: 'owner', created_at: 8 },
    ])).toBe([
      'Community knowledge (facts you know about this group):',
      '  events:',
      '    - Trivia is on Wednesdays',
      '    - Board games run monthly',
      '  venues:',
      '    - Preferred venue is in Cambridge',
    ].join('\n'));
  });

  it('maps raw rows into database API objects with numeric and JSON fidelity', () => {
    expect(mapMemberProfile({
      jid: '15550000001',
      name: null,
      interests: ['hiking', 12, 'trivia'],
      groups_active: '["group@g.us"]',
      event_count: '3',
      first_seen: '100',
      last_seen: 200,
      opted_in: '1',
    })).toEqual({
      jid: '15550000001',
      name: null,
      interests: '["hiking","trivia"]',
      groups_active: '["group@g.us"]',
      event_count: 3,
      first_seen: 100,
      last_seen: 200,
      opted_in: 1,
    });

    expect(mapDbMessage({ sender: '15550000002', text: 'hello', timestamp: '123' })).toEqual({
      sender: '15550000002',
      text: 'hello',
      timestamp: 123,
    });

    expect(mapFeedbackEntry({
      id: '4',
      type: 'bug',
      sender: '15550000003',
      group_jid: null,
      text: 'broken',
      status: 'open',
      upvotes: '2',
      upvoters: ['15550000004'],
      github_issue_number: null,
      github_issue_url: null,
      github_issue_created_at: null,
      timestamp: '300',
    })).toMatchObject({
      id: 4,
      upvotes: 2,
      upvoters: '["15550000004"]',
      github_issue_created_at: null,
      timestamp: 300,
    });

    expect(mapMemoryEntry({ id: '5', fact: 'fact', category: 'general', source: 'owner', created_at: '400' })).toEqual({
      id: 5,
      fact: 'fact',
      category: 'general',
      source: 'owner',
      created_at: 400,
    });

    expect(mapEventReminder({
      id: '6',
      chat_jid: 'events@g.us',
      activity: 'trivia night',
      location: null,
      event_at: '800',
      remind_at: '700',
      created_by: '15550000006@s.whatsapp.net',
      status: 'pending',
      created_at: '650',
    })).toEqual({
      id: 6,
      chatJid: 'events@g.us',
      activity: 'trivia night',
      location: null,
      eventAt: 800,
      remindAt: 700,
      createdBy: '15550000006@s.whatsapp.net',
      status: 'pending',
      createdAt: 650,
    });
  });

  it('maps WhatsApp safety and outbound rows across dialect count shapes', () => {
    const state = mapWhatsAppSafetyState({
      paused: '1',
      risk: 'high',
      score: '72',
      reasons: '["recent failures", 5]',
      updated_at: '500',
    });

    expect(state).toEqual({
      paused: true,
      risk: 'high',
      score: 72,
      reasons: ['recent failures'],
      updatedAt: 500,
    });

    expect(mapWhatsAppOutboundJob({
      id: '6',
      chat_jid: 'group@g.us',
      kind: 'text',
      content_json: '{"text":"hello"}',
      options_json: null,
      status: 'held',
      reason: null,
      attempts: '1',
      created_at: '600',
      updated_at: '601',
      sent_at: null,
    })).toMatchObject({
      id: 6,
      optionsJson: null,
      attempts: 1,
      sentAt: null,
    });

    expect(mapWhatsAppSafetyMetrics({
      pending: '2',
      held: null,
      sentLastHour: 3,
      sentLastDay: '4',
      failedLastHour: undefined,
    }, state)).toEqual({
      pending: 2,
      held: 0,
      sentLastHour: 3,
      sentLastDay: 4,
      failedLastHour: 0,
      paused: true,
      risk: 'high',
      score: 72,
    });
  });

  it('maps aggregate and session rows without dialect-specific SQL assumptions', () => {
    expect(mapDailyGroupActivity({ chatjid: 'group@g.us', messagecount: '7', activeusers: '2' })).toEqual({
      chatJid: 'group@g.us',
      messageCount: 7,
      activeUsers: 2,
    });

    expect(mapStrikeSummary({
      sender: '15550000005',
      strike_count: '3',
      last_flag: '700',
      reasons: null,
    })).toEqual({
      sender: '15550000005',
      strike_count: 3,
      last_flag: 700,
      reasons: '',
    });

    expect(mapSessionSummaryHit({
      id: '8',
      started_at: '100',
      ended_at: '200',
      message_count: '12',
      participants: '["15550000001"]',
      summary_text: 'Trivia in Cambridge',
      topic_tags: ['trivia', 'cambridge'],
    }, 0.87)).toEqual({
      sessionId: 8,
      startedAt: 100,
      endedAt: 200,
      messageCount: 12,
      participants: ['15550000001'],
      topicTags: ['trivia', 'cambridge'],
      summaryText: 'Trivia in Cambridge',
      score: 0.87,
    });
  });
});
