process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function mockMetricsDb(options: {
  memories?: Array<{ source: string }>;
  memoryThrows?: boolean;
  reminders?: unknown[];
  outboxCounts?: { pending: number; sent: number; dead: number; oldestPendingCreatedAt: number | null };
  bufferDepths?: Record<string, number>;
} = {}): void {
  vi.doMock('../src/utils/db.js', () => ({
    bridgeOutboxCounts: vi.fn(async () => options.outboxCounts ?? ({
      pending: 0,
      sent: 0,
      dead: 0,
      oldestPendingCreatedAt: null,
    })),
    bridgeBufferDepths: vi.fn(async () => options.bufferDepths ?? {}),
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
    stats.recordMarkdownV2Fallback('telegram');

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
    expect(text).toContain('garbanzo_markdown_v2_fallbacks_total{platform="telegram"} 1');
    expect(text).toContain('garbanzo_memory_facts{source="owner\\"quoted\\\\source\\nline"} 2');
    expect(text).toContain('garbanzo_event_reminders_pending 2');
  });

  it('renders bridge and memory rejection metrics from counters and scrape-time gauges', async () => {
    const now = 1_800_000_010_000;
    mockMetricsDb({
      outboxCounts: {
        pending: 3,
        sent: 9,
        dead: 1,
        oldestPendingCreatedAt: now - 25_000,
      },
      bufferDepths: {
        'route-1': 2,
      },
    });

    const stats = await import('../src/middleware/stats.js');
    stats.recordBridgeSent('route-1');
    stats.recordBridgeFailed('route-1');
    stats.recordBridgeDeadLettered('route-1');
    stats.recordBridgeSummaryFlush('route-1');
    stats.recordBridgeSeenDedupHit('route-1');
    stats.recordBridgeHeldByOutboundSafety('route-1');
    stats.recordBridgeDeliveryLatency('route-1', 100);
    stats.recordBridgeDeliveryLatency('route-1', 300);
    stats.recordMemorySaveRejection('rate-limit');
    stats.recordMemorySaveRejection('dedup');

    const { __testing } = await import('../src/middleware/health.js');
    const text = await __testing.renderPrometheusMetrics(now);

    expect(text).toContain('garbanzo_bridge_outbox_depth 3');
    expect(text).toContain('garbanzo_bridge_outbox_oldest_pending_age_seconds 25');
    expect(text).toContain('garbanzo_bridge_summary_buffer_size{route="route-1"} 2');
    expect(text).toContain('garbanzo_bridge_sent_total{route="route-1"} 1');
    expect(text).toContain('garbanzo_bridge_failed_total{route="route-1"} 1');
    expect(text).toContain('garbanzo_bridge_dead_lettered_total{route="route-1"} 1');
    expect(text).toContain('garbanzo_bridge_summary_flushes_total{route="route-1"} 1');
    expect(text).toContain('garbanzo_bridge_seen_dedup_hits_total{route="route-1"} 1');
    expect(text).toContain('garbanzo_bridge_held_by_outbound_safety_total{route="route-1"} 1');
    expect(text).toContain('garbanzo_bridge_delivery_latency_seconds_min{route="route-1"} 0.1');
    expect(text).toContain('garbanzo_bridge_delivery_latency_seconds_avg{route="route-1"} 0.2');
    expect(text).toContain('garbanzo_bridge_delivery_latency_seconds_max{route="route-1"} 0.3');
    expect(text).toContain('garbanzo_memory_save_rejections_total{reason="dedup"} 1');
    expect(text).toContain('garbanzo_memory_save_rejections_total{reason="rate-limit"} 1');
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
    expect(text).toContain('garbanzo_ai_latency_ms_avg{provider="claude"} 10');
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
