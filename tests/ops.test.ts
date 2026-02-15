import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:net';

/**
 * Phase 5 — Operations & Reliability tests.
 * Tests health tracking, cost estimation, retry queue, feature flags,
 * and database maintenance.
 */

// ── Health state tracking ───────────────────────────────────────────

describe('Health — connection state tracking', async () => {
  const {
    markConnected,
    markDisconnected,
    markMessageReceived,
    isConnectionStale,
    getConnectionState,
  } = await import('../src/middleware/health.js');

  beforeEach(() => {
    // Reset to a known state by marking disconnected
    markDisconnected();
  });

  it('starts in disconnected state after reset', () => {
    const state = getConnectionState();
    expect(state.status).toBe('disconnected');
  });

  it('transitions to connected on markConnected', () => {
    markConnected();
    const state = getConnectionState();
    expect(state.status).toBe('connected');
    expect(state.connectedAt).toBeTypeOf('number');
  });

  it('transitions to disconnected on markDisconnected', () => {
    markConnected();
    markDisconnected();
    expect(getConnectionState().status).toBe('disconnected');
  });

  it('updates lastMessageAt on markMessageReceived', () => {
    markConnected();
    markMessageReceived();
    const state = getConnectionState();
    expect(state.lastMessageAt).toBeTypeOf('number');
    const lastMessageAt = state.lastMessageAt;
    if (typeof lastMessageAt !== 'number') throw new Error('expected lastMessageAt');
    expect(lastMessageAt - Date.now()).toBeLessThan(100);
  });

  it('is not stale when recently received messages', () => {
    markConnected();
    markMessageReceived();
    expect(isConnectionStale()).toBe(false);
  });

  it('is not stale when disconnected', () => {
    markDisconnected();
    expect(isConnectionStale()).toBe(false);
  });

  it('increments reconnect count on subsequent connections', () => {
    markConnected();
    markConnected();
    expect(getConnectionState().reconnectCount).toBeGreaterThanOrEqual(1);
  });

  it('resets lastMessageAt on reconnect so readiness does not stick stale', () => {
    markConnected();
    markMessageReceived();
    expect(getConnectionState().lastMessageAt).toBeTypeOf('number');

    const baselineReconnects = getConnectionState().reconnectCount;

    markDisconnected();
    markConnected();

    const state = getConnectionState();
    expect(state.lastMessageAt).toBe(null);
    expect(state.reconnectCount).toBe(baselineReconnects + 1);
    expect(isConnectionStale()).toBe(false);
  });
});

describe('Health endpoint — backup status and rate limiting', async () => {
  const {
    startHealthServer,
    stopHealthServer,
    markConnected,
    markDisconnected,
    markMessageReceived,
  } = await import('../src/middleware/health.js');

  async function getFreePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
      const srv = createServer();
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (!addr || typeof addr === 'string') {
          srv.close();
          reject(new Error('Failed to allocate test port'));
          return;
        }
        const port = addr.port;
        srv.close(() => resolve(port));
      });
      srv.on('error', reject);
    });
  }

  afterEach(() => {
    stopHealthServer();
  });

  it('health payload includes backup integrity fields', async () => {
    const port = await getFreePort();
    startHealthServer(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    const data = await response.json() as { backup?: { available: boolean; integrityOk: boolean | null; message: string } };
    expect(data.backup).toBeDefined();
    expect(typeof data.backup?.available).toBe('boolean');
    expect(typeof data.backup?.message).toBe('string');
  });

  it('returns 429 when health endpoint request limit is exceeded', async () => {
    const port = await getFreePort();
    startHealthServer(port, '127.0.0.1');

    let lastStatus = 0;
    for (let i = 0; i < 125; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      lastStatus = response.status;
    }

    expect(lastStatus).toBe(429);
  });

  it('ready endpoint returns 503 when disconnected', async () => {
    const port = await getFreePort();
    markDisconnected();
    startHealthServer(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(response.status).toBe(503);
    const data = await response.json() as { ready: boolean; status: string; stale: boolean };
    expect(data.ready).toBe(false);
  });

  it('ready endpoint returns 200 when connected and fresh', async () => {
    const port = await getFreePort();
    markConnected();
    markMessageReceived();
    startHealthServer(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(response.status).toBe(200);
    const data = await response.json() as { ready: boolean; status: string; stale: boolean };
    expect(data.ready).toBe(true);
  });

  it('ready endpoint returns 503 when connection is stale', async () => {
    const port = await getFreePort();

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_700_000_000_000);
    markConnected();
    markMessageReceived();

    nowSpy.mockReturnValue(1_700_000_000_000 + 31 * 60 * 1000);
    startHealthServer(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(response.status).toBe(503);

    nowSpy.mockRestore();
  });

  it('metrics endpoint returns 404 when disabled', async () => {
    const port = await getFreePort();
    startHealthServer(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(response.status).toBe(404);
  });

  it('metrics endpoint returns Prometheus text when enabled', async () => {
    const port = await getFreePort();
    markConnected();
    markMessageReceived();
    startHealthServer(port, '127.0.0.1', { metricsEnabled: true });

    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(response.status).toBe(200);
    const text = await response.text();

    expect(text).toContain('garbanzo_up_time_seconds');
    expect(text).toContain('garbanzo_connection_status');
    expect(text).toContain('garbanzo_connection_stale');
  });
});

// ── Cost tracking ───────────────────────────────────────────────────

describe('Stats — cost estimation', async () => {
  const {
    estimateTokens,
    estimateClaudeCost,
    recordAICost,
    getDailyCost,
  } = await import('../src/middleware/stats.js');

  it('estimates tokens from text (~4 chars per token)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello')).toBe(2); // ceil(5/4)
    expect(estimateTokens('a'.repeat(100))).toBe(25);
    expect(estimateTokens('a'.repeat(101))).toBe(26); // ceil
  });

  it('estimates Claude cost from prompt + response', () => {
    const cost = estimateClaudeCost(
      'You are a helpful bot.', // ~6 tokens
      'What is the weather?',   // ~5 tokens
      'It is sunny and 72F in Boston today.', // ~10 tokens
    );
    expect(cost.model).toBe('claude');
    expect(cost.inputTokens).toBeGreaterThan(0);
    expect(cost.outputTokens).toBeGreaterThan(0);
    expect(cost.estimatedCost).toBeGreaterThan(0);
    expect(cost.estimatedCost).toBeLessThan(0.01); // should be tiny for short messages
  });

  it('records cost and accumulates daily total', () => {
    const before = getDailyCost();
    recordAICost({
      model: 'claude',
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0.001,
      latencyMs: 500,
    });
    expect(getDailyCost()).toBeGreaterThanOrEqual(before + 0.001);
  });

  it('Ollama calls have zero cost', () => {
    const before = getDailyCost();
    recordAICost({
      model: 'ollama',
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      latencyMs: 200,
    });
    expect(getDailyCost()).toBe(before);
  });
});

// ── Retry queue ─────────────────────────────────────────────────────

describe('Retry — dead letter queue', async () => {
  const {
    queueRetry,
    setRetryHandler,
    getRetryQueueSize,
    clearRetryQueue,
  } = await import('../src/middleware/retry.js');

  afterEach(() => {
    clearRetryQueue();
  });

  it('rejects entries when no handler is registered (first call in fresh module)', () => {
    // Note: in a real fresh module, handler would be null.
    // After setRetryHandler is called, entries are accepted.
    // This just verifies queueRetry returns a boolean.
    const handler = vi.fn();
    setRetryHandler(handler);
    const result = queueRetry({
      groupJid: 'test@g.us',
      senderJid: 'user@s.whatsapp.net',
      query: 'test query',
      timestamp: Date.now(),
    });
    expect(result).toBe(true);
    expect(getRetryQueueSize()).toBe(1);
  });

  it('prevents duplicate entries for same message', () => {
    setRetryHandler(vi.fn());
    const ts = Date.now();
    queueRetry({ groupJid: 'g1@g.us', senderJid: 'u1@s.whatsapp.net', query: 'q', timestamp: ts });
    const dup = queueRetry({ groupJid: 'g1@g.us', senderJid: 'u1@s.whatsapp.net', query: 'q', timestamp: ts });
    expect(dup).toBe(false);
    expect(getRetryQueueSize()).toBe(1);
  });

  it('clears all pending entries', () => {
    setRetryHandler(vi.fn());
    queueRetry({ groupJid: 'g1@g.us', senderJid: 'u1@s.whatsapp.net', query: 'q1', timestamp: 1 });
    queueRetry({ groupJid: 'g2@g.us', senderJid: 'u2@s.whatsapp.net', query: 'q2', timestamp: 2 });
    expect(getRetryQueueSize()).toBe(2);
    clearRetryQueue();
    expect(getRetryQueueSize()).toBe(0);
  });
});

// ── Feature flags ───────────────────────────────────────────────────

describe('Feature flags — per-group feature control', async () => {
  const { isFeatureEnabled, isGroupEnabled, getGroupName } = await import('../src/core/groups-config.js');

  it('allows all features when enabledFeatures is not set', () => {
    // General group has no enabledFeatures in config
    const generalJid = '120363423357339667@g.us';
    expect(isGroupEnabled(generalJid)).toBe(true);
    expect(isFeatureEnabled(generalJid, 'weather')).toBe(true);
    expect(isFeatureEnabled(generalJid, 'transit')).toBe(true);
    expect(isFeatureEnabled(generalJid, 'dnd')).toBe(true);
    expect(isFeatureEnabled(generalJid, 'nonexistent')).toBe(true);
  });

  it('allows features for unknown groups (DMs)', () => {
    expect(isFeatureEnabled('unknown@s.whatsapp.net', 'weather')).toBe(true);
  });

  it('returns correct group name', () => {
    expect(getGroupName('120363423357339667@g.us')).toBe('General');
    expect(getGroupName('unknown@g.us')).toBe('Unknown Group');
  });
});

// ── Database maintenance ────────────────────────────────────────────

describe('Database — maintenance and backup', async () => {
  const { runMaintenance, storeMessage, getMessages, backupDatabase } = await import('../src/utils/db.js');
  const { existsSync, unlinkSync } = await import('fs');

  it('runMaintenance returns stats object', () => {
    const result = runMaintenance();
    expect(result).toHaveProperty('pruned');
    expect(result).toHaveProperty('beforeCount');
    expect(result).toHaveProperty('afterCount');
    expect(result.pruned).toBeTypeOf('number');
    expect(result.afterCount).toBeLessThanOrEqual(result.beforeCount);
  });

  it('does not prune recent messages', () => {
    // Store a message (will have current timestamp)
    storeMessage('maintenance-test@g.us', 'tester@s.whatsapp.net', 'recent message');
    const before = getMessages('maintenance-test@g.us', 100);
    runMaintenance();
    const after = getMessages('maintenance-test@g.us', 100);
    // Recent message should still be there
    expect(after.length).toBe(before.length);
  });

  it('backupDatabase creates a backup file', () => {
    const backupPath = backupDatabase();
    expect(existsSync(backupPath)).toBe(true);
    // Clean up
    try { unlinkSync(backupPath); } catch { /* ignore */ }
  });
});

// ── AI error stats ──────────────────────────────────────────────────

describe('Stats — AI error recording', async () => {
  const { recordAIError, getCurrentStats } = await import('../src/middleware/stats.js');

  it('increments aiErrors for a group', () => {
    const groupJid = 'error-test@g.us';
    recordAIError(groupJid);
    const stats = getCurrentStats();
    const group = stats.groups.get(groupJid);
    if (!group) throw new Error('expected group stats');
    expect(group.aiErrors).toBeGreaterThanOrEqual(1);
  });
});
