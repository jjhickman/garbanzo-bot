process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function mockMetricsDb(options: {
  memories?: Array<{ source: string }>;
  memoryThrows?: boolean;
  reminders?: unknown[];
} = {}): void {
  vi.doMock('../src/utils/db.js', () => ({
    verifyLatestBackupIntegrity: vi.fn(async () => ({
      available: true,
      integrityOk: true,
      message: 'ok',
      latestPath: 'backup.sqlite',
    })),
    getWhatsAppSafetyMetrics: vi.fn(async () => ({
      held: 0,
      paused: false,
      risk: 'low',
      score: 0,
      sentLastHour: 0,
      sentLastDay: 0,
    })),
    getAllMemories: vi.fn(async () => {
      if (options.memoryThrows) throw new Error('memory db unavailable');
      return options.memories ?? [];
    }),
    listUpcomingEventReminders: vi.fn(async () => options.reminders ?? []),
  }));
}

describe('Prometheus metrics expansion', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('renders lifetime counters with display-name labels and escaped label values', async () => {
    mockMetricsDb({
      memories: [
        { source: 'owner"quoted\\source\nline' },
        { source: 'owner"quoted\\source\nline' },
      ],
      reminders: [{ id: 1 }, { id: 2 }],
    });

    const stats = await import('../src/middleware/stats.js');
    const generalJid = '120363423357339667@g.us';
    stats.recordGroupMessage(generalJid, 'alice@s.whatsapp.net');
    stats.recordBotResponse(generalJid);
    stats.recordAIRoute(generalJid, 'openai');
    stats.recordAIError(generalJid);
    stats.recordModerationFlag(generalJid);
    stats.recordOwnerDM();
    stats.recordAICost({
      model: 'openai',
      inputTokens: 10,
      outputTokens: 5,
      estimatedCost: 0.25,
      latencyMs: 50,
    });

    const { __testing } = await import('../src/middleware/health.js');
    const text = await __testing.renderPrometheusMetrics(Date.now());

    expect(text).toContain('# TYPE garbanzo_messages_total counter');
    expect(text).toContain('garbanzo_messages_total{group="General"} 1');
    expect(text).toContain('garbanzo_bot_responses_total{group="General"} 1');
    expect(text).toContain('garbanzo_ai_requests_total{provider="openai"} 1');
    expect(text).toContain('garbanzo_ai_errors_total{group="General"} 1');
    expect(text).toContain('garbanzo_moderation_flags_total{group="General"} 1');
    expect(text).toContain('garbanzo_owner_dms_total 1');
    expect(text).toContain('garbanzo_ai_cost_usd_total{provider="openai"} 0.25');
    expect(text).toContain('garbanzo_memory_facts{source="owner\\"quoted\\\\source\\nline"} 2');
    expect(text).toContain('garbanzo_event_reminders_pending 2');
  });

  it('renders daily gauges from current in-memory stats', async () => {
    mockMetricsDb();
    const stats = await import('../src/middleware/stats.js');
    const generalJid = '120363423357339667@g.us';
    stats.recordGroupMessage(generalJid, 'alice@s.whatsapp.net');
    stats.recordGroupMessage(generalJid, 'bob@s.whatsapp.net');
    stats.recordBotResponse(generalJid);
    stats.recordAICost({
      model: 'claude',
      inputTokens: 1,
      outputTokens: 1,
      estimatedCost: 0.01,
      latencyMs: 10,
    });

    const { __testing } = await import('../src/middleware/health.js');
    const text = await __testing.renderPrometheusMetrics(Date.now());

    expect(text).toContain('# TYPE garbanzo_daily_cost_usd gauge');
    expect(text).toContain('garbanzo_daily_cost_usd 0.01');
    expect(text).toContain('garbanzo_daily_messages{group="General"} 2');
    expect(text).toContain('garbanzo_daily_bot_responses{group="General"} 1');
    expect(text).toContain('garbanzo_daily_active_users{group="General"} 2');
  });

  it('keeps serving metrics when memory fact gauges fail', async () => {
    mockMetricsDb({
      memoryThrows: true,
      reminders: [{ id: 1 }],
    });

    const { __testing } = await import('../src/middleware/health.js');
    const text = await __testing.renderPrometheusMetrics(Date.now());

    expect(text).toContain('garbanzo_up_time_seconds');
    expect(text).toContain('garbanzo_event_reminders_pending 1');
    expect(text).not.toContain('garbanzo_memory_facts');
  });
});
