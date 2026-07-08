/**
 * Health check HTTP endpoint + connection state tracker.
 *
 * Exposes a tiny HTTP server on localhost that returns JSON with:
 * - Platform connection status (connected/disconnected/connecting)
 * - Uptime in seconds
 * - Last message received timestamp
 * - Memory usage
 * - Ollama availability
 *
 * Also reports incoming-message inactivity. A quiet group is not sufficient
 * evidence of a failed WhatsApp session, so inactivity is informational only.
 */

import { timingSafeEqual } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { logger } from './logger.js';
import { buildAdminSnapshot, renderAdminHtml } from './admin-page.js';
import {
  bridgeBufferDepths,
  bridgeOutboxCounts,
  getAllMemories,
  getWhatsAppSafetyMetrics,
  listUpcomingEventReminders,
  verifyLatestBackupIntegrity,
  type BackupIntegrityStatus,
} from '../utils/db.js';
import { getCurrentStats, getDailyCost, getLifetimeCounters } from './stats.js';
import { getGroupName } from '../core/groups-config.js';
import { getVectorStore } from '../utils/vector-memory.js';
import { parseBridgeEnvelope, type BridgeEnvelope } from '../bridge/envelope.js';
import { BridgeDeliveryDeferredError } from '../bridge/transport.js';

// ── Connection state ────────────────────────────────────────────────

export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting';

interface ConnectionState {
  status: ConnectionStatus;
  connectedAt: number | null;
  lastMessageAt: number | null;
  reconnectCount: number;
  startedAt: number;
}

const state: ConnectionState = {
  status: 'connecting',
  connectedAt: null,
  lastMessageAt: null,
  reconnectCount: 0,
  startedAt: Date.now(),
};

/** Call when a platform connection opens */
export function markConnected(): void {
  // Count reconnects when we have previously been connected in this process.
  if (state.connectedAt !== null) {
    state.reconnectCount++;
  }

  state.status = 'connected';
  state.connectedAt = Date.now();

  // Reset message freshness on reconnect.
  // Otherwise, a stale `lastMessageAt` from a prior connection can cause `/health/ready`
  // to remain 503 until a new message arrives.
  state.lastMessageAt = null;
}

/** Call when a platform connection closes */
export function markDisconnected(): void {
  state.status = 'disconnected';
}

/** Call on every incoming message to track freshness */
export function markMessageReceived(): void {
  state.lastMessageAt = Date.now();
}

/** Check if the connection is stale (connected but no messages for 30+ min) */
export function isConnectionStale(): boolean {
  if (state.status !== 'connected') return false;
  if (state.lastMessageAt === null) {
    // Never received a message — check time since connection
    if (state.connectedAt === null) return false;
    return Date.now() - state.connectedAt > STALE_THRESHOLD_MS;
  }
  return Date.now() - state.lastMessageAt > STALE_THRESHOLD_MS;
}

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/** Get current connection state (for health endpoint + staleness monitor) */
export function getConnectionState(): ConnectionState {
  return { ...state };
}

// ── Health HTTP server ──────────────────────────────────────────────

let server: Server | null = null;

const HEALTH_RATE_WINDOW_MS = 60_000;
const HEALTH_RATE_LIMIT = 120;
const BRIDGE_INBOUND_BODY_LIMIT_BYTES = 64 * 1024;

const healthRateWindow = new Map<string, { windowStart: number; count: number }>();

const BACKUP_CHECK_CACHE_MS = 5 * 60_000;
let backupStatusCache: { checkedAt: number; status: BackupIntegrityStatus } | null = null;

type BridgeInboundHandler = (envelope: BridgeEnvelope) => Promise<'accepted' | 'duplicate'>;

interface HealthServerOptions {
  metricsEnabled?: boolean;
  authToken?: string;
  /** Serve the owner admin page at /admin (+ /admin.json). Requires authToken. */
  adminEnabled?: boolean;
  bridgeInboundHandler?: BridgeInboundHandler;
  extraHandler?: (req: IncomingMessage, res: ServerResponse) => boolean;
}

interface VectorStoreHealth {
  ok: boolean;
  disabled?: boolean;
  detail?: string;
}

export function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

function isHealthRequestRateLimited(ip: string, now: number): boolean {
  const key = normalizeIp(ip);
  // Opportunistic eviction so the map cannot grow unbounded over long uptimes.
  for (const [k, v] of healthRateWindow) {
    if (now - v.windowStart >= HEALTH_RATE_WINDOW_MS) healthRateWindow.delete(k);
  }
  const existing = healthRateWindow.get(key);
  if (!existing || now - existing.windowStart >= HEALTH_RATE_WINDOW_MS) {
    healthRateWindow.set(key, { windowStart: now, count: 1 });
    return false;
  }

  existing.count += 1;
  return existing.count > HEALTH_RATE_LIMIT;
}

function tokenMatches(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  if (expected.length === 0) return false;

  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function requestHasValidToken(req: IncomingMessage, expected: string): boolean {
  const rawUrl = req.url ?? '';
  const queryToken = new URLSearchParams(rawUrl.split('?')[1] ?? '').get('token');
  return tokenMatches(queryToken, expected) || tokenMatches(bearerToken(req), expected);
}

function writeJson(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('payload_too_large');
  }
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const rejectOnce = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        rejectOnce(new PayloadTooLargeError());
        return;
      }
      chunks.push(buffer);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', (err) => {
      rejectOnce(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

async function handleBridgeInbound(
  req: IncomingMessage,
  res: ServerResponse,
  options: HealthServerOptions & { bridgeInboundHandler: BridgeInboundHandler },
): Promise<void> {
  const now = Date.now();
  const ip = req.socket.remoteAddress ?? 'unknown';
  if (isHealthRequestRateLimited(ip, now)) {
    writeJson(res, 429, { error: 'rate_limited' });
    return;
  }

  if (!requestHasValidToken(req, options.authToken ?? '')) {
    writeJson(res, 401, { error: 'unauthorized' });
    return;
  }

  if (req.method !== 'POST') {
    writeJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  let body: string;
  try {
    body = await readRequestBody(req, BRIDGE_INBOUND_BODY_LIMIT_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      writeJson(res, 413, { error: 'payload_too_large' });
      return;
    }
    throw err;
  }

  let rawEnvelope: unknown;
  try {
    rawEnvelope = JSON.parse(body) as unknown;
  } catch {
    writeJson(res, 400, { error: 'invalid json' });
    return;
  }

  const envelope = parseBridgeEnvelope(rawEnvelope);
  if (!envelope) {
    writeJson(res, 400, { error: 'invalid envelope' });
    return;
  }

  try {
    const result = await options.bridgeInboundHandler(envelope);
    if (result === 'duplicate') {
      writeJson(res, 200, { status: 'duplicate' });
      return;
    }
    writeJson(res, 202, { status: 'accepted' });
  } catch (err) {
    if (err instanceof BridgeDeliveryDeferredError) {
      logger.info(
        { routeId: envelope.routeId, retryAtMs: err.retryAtMs },
        'Bridge inbound delivery deferred',
      );
      writeJson(res, 429, { error: 'delivery deferred', retryAtMs: err.retryAtMs });
      return;
    }

    logger.warn({ err, routeId: envelope.routeId }, 'Bridge inbound handler failed');
    writeJson(res, 503, { error: 'delivery failed' });
  }
}

async function getCachedBackupStatus(now: number): Promise<{ checkedAt: number; status: BackupIntegrityStatus }> {
  if (!backupStatusCache || now - backupStatusCache.checkedAt >= BACKUP_CHECK_CACHE_MS) {
    backupStatusCache = {
      checkedAt: now,
      status: await verifyLatestBackupIntegrity(),
    };
  }
  return backupStatusCache;
}

async function getVectorStoreHealth(): Promise<VectorStoreHealth> {
  const vectorStore = getVectorStore();
  if (!vectorStore) return { ok: true, disabled: true };

  try {
    return await vectorStore.health();
  } catch (err) {
    logger.warn({ err }, 'Vector store health check failed');
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function escapePrometheusLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function groupLabelValue(groupJid: string): string {
  return escapePrometheusLabelValue(getGroupName(groupJid));
}

function pushCounterMap(
  lines: string[],
  name: string,
  labelName: string,
  counters: ReadonlyMap<string, number>,
): void {
  for (const [labelValue, value] of Array.from(counters).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${name}{${labelName}="${escapePrometheusLabelValue(labelValue)}"} ${value}`);
  }
}

function pushGroupCounterMap(
  lines: string[],
  name: string,
  counters: ReadonlyMap<string, number>,
): void {
  for (const [groupJid, value] of Array.from(counters).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${name}{group="${groupLabelValue(groupJid)}"} ${value}`);
  }
}

function pushBridgeRouteCounterMap(
  lines: string[],
  name: string,
  counters: ReadonlyMap<string, number>,
): void {
  pushCounterMap(lines, name, 'route', counters);
}

function pushLifetimeCounters(lines: string[]): void {
  const lifetime = getLifetimeCounters();

  lines.push('# HELP garbanzo_messages_total Total observed group messages by group for this process lifetime.');
  lines.push('# TYPE garbanzo_messages_total counter');
  pushGroupCounterMap(lines, 'garbanzo_messages_total', lifetime.messagesByGroupJid);

  lines.push('# HELP garbanzo_bot_responses_total Total bot responses by group for this process lifetime.');
  lines.push('# TYPE garbanzo_bot_responses_total counter');
  pushGroupCounterMap(lines, 'garbanzo_bot_responses_total', lifetime.botResponsesByGroupJid);

  lines.push('# HELP garbanzo_ai_requests_total Total AI requests by provider for this process lifetime.');
  lines.push('# TYPE garbanzo_ai_requests_total counter');
  pushCounterMap(lines, 'garbanzo_ai_requests_total', 'provider', lifetime.aiRequestsByProvider);

  lines.push('# HELP garbanzo_ai_errors_total Total AI errors by group for this process lifetime.');
  lines.push('# TYPE garbanzo_ai_errors_total counter');
  pushGroupCounterMap(lines, 'garbanzo_ai_errors_total', lifetime.aiErrorsByGroupJid);

  lines.push('# HELP garbanzo_moderation_flags_total Total moderation flags by group for this process lifetime.');
  lines.push('# TYPE garbanzo_moderation_flags_total counter');
  pushGroupCounterMap(lines, 'garbanzo_moderation_flags_total', lifetime.moderationFlagsByGroupJid);

  lines.push('# HELP garbanzo_owner_dms_total Total owner DM interactions for this process lifetime.');
  lines.push('# TYPE garbanzo_owner_dms_total counter');
  lines.push(`garbanzo_owner_dms_total ${lifetime.ownerDmsTotal}`);

  lines.push('# HELP garbanzo_ai_cost_usd_total Total estimated AI cost in USD by provider for this process lifetime.');
  lines.push('# TYPE garbanzo_ai_cost_usd_total counter');
  pushCounterMap(lines, 'garbanzo_ai_cost_usd_total', 'provider', lifetime.aiCostUsdByProvider);

  lines.push('# HELP garbanzo_rate_limited_total Total bot response requests rejected by rate limiting for this process lifetime.');
  lines.push('# TYPE garbanzo_rate_limited_total counter');
  lines.push(`garbanzo_rate_limited_total ${lifetime.rateLimitedTotal}`);

  lines.push('# HELP garbanzo_tool_calls_total Total AI tool calls by tool and outcome for this process lifetime.');
  lines.push('# TYPE garbanzo_tool_calls_total counter');
  for (const [tool, counts] of Array.from(lifetime.toolCalls).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`garbanzo_tool_calls_total{tool="${escapePrometheusLabelValue(tool)}",outcome="ok"} ${counts.ok}`);
    lines.push(`garbanzo_tool_calls_total{tool="${escapePrometheusLabelValue(tool)}",outcome="error"} ${counts.error}`);
  }

  lines.push('# HELP garbanzo_event_reminders_sent_total Total event reminders successfully sent for this process lifetime.');
  lines.push('# TYPE garbanzo_event_reminders_sent_total counter');
  lines.push(`garbanzo_event_reminders_sent_total ${lifetime.eventRemindersSentTotal}`);

  lines.push('# HELP garbanzo_markdown_v2_fallbacks_total Total Telegram MarkdownV2 parse fallback sends by platform for this process lifetime.');
  lines.push('# TYPE garbanzo_markdown_v2_fallbacks_total counter');
  pushCounterMap(lines, 'garbanzo_markdown_v2_fallbacks_total', 'platform', lifetime.markdownV2FallbacksByPlatform);

  lines.push('# HELP garbanzo_bridge_sent_total Total bridge outbox envelopes successfully delivered to peer instances by route for this process lifetime.');
  lines.push('# TYPE garbanzo_bridge_sent_total counter');
  pushBridgeRouteCounterMap(lines, 'garbanzo_bridge_sent_total', lifetime.bridgeSentByRoute);

  lines.push('# HELP garbanzo_bridge_failed_total Total bridge outbox delivery failures by route for this process lifetime.');
  lines.push('# TYPE garbanzo_bridge_failed_total counter');
  pushBridgeRouteCounterMap(lines, 'garbanzo_bridge_failed_total', lifetime.bridgeFailedByRoute);

  lines.push('# HELP garbanzo_bridge_dead_lettered_total Total bridge outbox envelopes dead-lettered by route for this process lifetime.');
  lines.push('# TYPE garbanzo_bridge_dead_lettered_total counter');
  pushBridgeRouteCounterMap(lines, 'garbanzo_bridge_dead_lettered_total', lifetime.bridgeDeadLetteredByRoute);

  lines.push('# HELP garbanzo_bridge_summary_flushes_total Total successful bridge summary-buffer flush sends by route for this process lifetime.');
  lines.push('# TYPE garbanzo_bridge_summary_flushes_total counter');
  pushBridgeRouteCounterMap(lines, 'garbanzo_bridge_summary_flushes_total', lifetime.bridgeSummaryFlushesByRoute);

  lines.push('# HELP garbanzo_bridge_seen_dedup_hits_total Total bridge_seen duplicate idempotency-key hits by route for this process lifetime.');
  lines.push('# TYPE garbanzo_bridge_seen_dedup_hits_total counter');
  pushBridgeRouteCounterMap(lines, 'garbanzo_bridge_seen_dedup_hits_total', lifetime.bridgeSeenDedupHitsByRoute);

  lines.push('# HELP garbanzo_bridge_held_by_outbound_safety_total Total bridge relay sends held by WhatsApp outbound safety by route for this process lifetime.');
  lines.push('# TYPE garbanzo_bridge_held_by_outbound_safety_total counter');
  pushBridgeRouteCounterMap(lines, 'garbanzo_bridge_held_by_outbound_safety_total', lifetime.bridgeHeldByOutboundSafetyByRoute);

  lines.push('# HELP garbanzo_bridge_delivery_latency_seconds_min Minimum bridge platform-delivery latency over the in-process rolling window by route.');
  lines.push('# TYPE garbanzo_bridge_delivery_latency_seconds_min gauge');
  for (const [route, latency] of Array.from(lifetime.bridgeDeliveryLatencyByRoute).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`garbanzo_bridge_delivery_latency_seconds_min{route="${escapePrometheusLabelValue(route)}"} ${latency.minSeconds}`);
  }

  lines.push('# HELP garbanzo_bridge_delivery_latency_seconds_avg Average bridge platform-delivery latency over the in-process rolling window by route.');
  lines.push('# TYPE garbanzo_bridge_delivery_latency_seconds_avg gauge');
  for (const [route, latency] of Array.from(lifetime.bridgeDeliveryLatencyByRoute).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`garbanzo_bridge_delivery_latency_seconds_avg{route="${escapePrometheusLabelValue(route)}"} ${latency.avgSeconds}`);
  }

  lines.push('# HELP garbanzo_bridge_delivery_latency_seconds_max Maximum bridge platform-delivery latency over the in-process rolling window by route.');
  lines.push('# TYPE garbanzo_bridge_delivery_latency_seconds_max gauge');
  for (const [route, latency] of Array.from(lifetime.bridgeDeliveryLatencyByRoute).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`garbanzo_bridge_delivery_latency_seconds_max{route="${escapePrometheusLabelValue(route)}"} ${latency.maxSeconds}`);
  }

  lines.push('# HELP garbanzo_memory_save_rejections_total Total save_community_memory rejections by reason for this process lifetime.');
  lines.push('# TYPE garbanzo_memory_save_rejections_total counter');
  pushCounterMap(lines, 'garbanzo_memory_save_rejections_total', 'reason', lifetime.memorySaveRejectionsByReason);
}

function pushDailyGauges(lines: string[]): void {
  const stats = getCurrentStats();

  lines.push('# HELP garbanzo_daily_cost_usd Estimated AI cost in USD for the current local day.');
  lines.push('# TYPE garbanzo_daily_cost_usd gauge');
  lines.push(`garbanzo_daily_cost_usd ${getDailyCost()}`);

  lines.push('# HELP garbanzo_daily_messages Current local-day observed group messages by group.');
  lines.push('# TYPE garbanzo_daily_messages gauge');
  for (const [groupJid, group] of Array.from(stats.groups).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`garbanzo_daily_messages{group="${groupLabelValue(groupJid)}"} ${group.messageCount}`);
  }

  lines.push('# HELP garbanzo_daily_bot_responses Current local-day bot responses by group.');
  lines.push('# TYPE garbanzo_daily_bot_responses gauge');
  for (const [groupJid, group] of Array.from(stats.groups).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`garbanzo_daily_bot_responses{group="${groupLabelValue(groupJid)}"} ${group.botResponses}`);
  }

  lines.push('# HELP garbanzo_daily_active_users Current local-day active users by group.');
  lines.push('# TYPE garbanzo_daily_active_users gauge');
  for (const [groupJid, group] of Array.from(stats.groups).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`garbanzo_daily_active_users{group="${groupLabelValue(groupJid)}"} ${group.activeUsers.size}`);
  }

  const latencyByProvider = new Map<string, { totalMs: number; count: number }>();
  for (const entry of stats.costs) {
    const currentProvider = latencyByProvider.get(entry.model) ?? { totalMs: 0, count: 0 };
    currentProvider.totalMs += Math.max(0, entry.latencyMs);
    currentProvider.count += 1;
    latencyByProvider.set(entry.model, currentProvider);
  }

  lines.push('# HELP garbanzo_ai_latency_ms_avg Current local-day average AI response latency by provider in milliseconds.');
  lines.push('# TYPE garbanzo_ai_latency_ms_avg gauge');
  for (const [provider, latency] of Array.from(latencyByProvider).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`garbanzo_ai_latency_ms_avg{provider="${escapePrometheusLabelValue(provider)}"} ${latency.totalMs / latency.count}`);
  }
}

async function pushMemoryFactGauge(lines: string[]): Promise<void> {
  try {
    const memories = await getAllMemories();
    const bySource = new Map<string, number>();
    for (const memory of memories) {
      bySource.set(memory.source, (bySource.get(memory.source) ?? 0) + 1);
    }

    lines.push('# HELP garbanzo_memory_facts Number of stored community memory facts by source.');
    lines.push('# TYPE garbanzo_memory_facts gauge');
    pushCounterMap(lines, 'garbanzo_memory_facts', 'source', bySource);
  } catch (err) {
    logger.warn({ err }, 'Skipping memory fact Prometheus gauge');
  }
}

async function pushEventReminderPendingGauge(lines: string[]): Promise<void> {
  try {
    const reminders = await listUpcomingEventReminders(100);
    lines.push('# HELP garbanzo_event_reminders_pending Number of pending upcoming event reminders.');
    lines.push('# TYPE garbanzo_event_reminders_pending gauge');
    lines.push(`garbanzo_event_reminders_pending ${reminders.length}`);
  } catch (err) {
    logger.warn({ err }, 'Skipping pending event reminder Prometheus gauge');
  }
}

async function pushBridgeOutboxGauges(lines: string[], now: number): Promise<void> {
  try {
    const counts = await bridgeOutboxCounts();
    const oldestPendingAgeSeconds = counts.oldestPendingCreatedAt === null
      ? 0
      : Math.max(0, Math.floor((now - counts.oldestPendingCreatedAt) / 1000));

    lines.push('# HELP garbanzo_bridge_outbox_depth Number of bridge outbox rows pending or claimed at scrape time.');
    lines.push('# TYPE garbanzo_bridge_outbox_depth gauge');
    lines.push(`garbanzo_bridge_outbox_depth ${counts.pending}`);

    lines.push('# HELP garbanzo_bridge_outbox_oldest_pending_age_seconds Age of the oldest pending or claimed bridge outbox row at scrape time; 0 when none are pending.');
    lines.push('# TYPE garbanzo_bridge_outbox_oldest_pending_age_seconds gauge');
    lines.push(`garbanzo_bridge_outbox_oldest_pending_age_seconds ${oldestPendingAgeSeconds}`);
  } catch (err) {
    logger.warn({ err }, 'Skipping bridge outbox Prometheus gauges');
  }
}

async function pushBridgeSummaryBufferGauges(lines: string[]): Promise<void> {
  try {
    const depths = await bridgeBufferDepths();

    lines.push('# HELP garbanzo_bridge_summary_buffer_size Number of envelopes currently buffered for bridge summary flush by route.');
    lines.push('# TYPE garbanzo_bridge_summary_buffer_size gauge');
    for (const [route, depth] of Object.entries(depths).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`garbanzo_bridge_summary_buffer_size{route="${escapePrometheusLabelValue(route)}"} ${depth}`);
    }
  } catch (err) {
    logger.warn({ err }, 'Skipping bridge summary buffer Prometheus gauges');
  }
}

/**
 * Start the local HTTP health endpoint (`/health`) with lightweight abuse protection.
 */
async function renderPrometheusMetrics(now: number): Promise<string> {
  const stale = isConnectionStale();
  const uptimeSeconds = Math.floor((now - state.startedAt) / 1000);
  const connectedForSeconds = state.connectedAt ? Math.floor((now - state.connectedAt) / 1000) : -1;
  const lastMessageAgoSeconds = state.lastMessageAt ? Math.floor((now - state.lastMessageAt) / 1000) : -1;
  const mem = process.memoryUsage();
  const backup = await getCachedBackupStatus(now);
  const whatsappSafety = await getWhatsAppSafetyMetrics(
    Math.floor((now - 60 * 60 * 1000) / 1000),
    Math.floor((now - 24 * 60 * 60 * 1000) / 1000),
  );

  const statusConnected = state.status === 'connected' ? 1 : 0;
  const statusConnecting = state.status === 'connecting' ? 1 : 0;
  const statusDisconnected = state.status === 'disconnected' ? 1 : 0;

  const backupIntegrityOk = backup.status.integrityOk === true ? 1 : 0;
  const backupAvailable = backup.status.available ? 1 : 0;

  const lines: string[] = [];
  lines.push('# HELP garbanzo_up_time_seconds Process uptime in seconds.');
  lines.push('# TYPE garbanzo_up_time_seconds gauge');
  lines.push(`garbanzo_up_time_seconds ${uptimeSeconds}`);

  lines.push('# HELP garbanzo_connection_status Platform connection status as one-hot gauges.');
  lines.push('# TYPE garbanzo_connection_status gauge');
  lines.push(`garbanzo_connection_status{status="connected"} ${statusConnected}`);
  lines.push(`garbanzo_connection_status{status="connecting"} ${statusConnecting}`);
  lines.push(`garbanzo_connection_status{status="disconnected"} ${statusDisconnected}`);

  lines.push('# HELP garbanzo_connection_stale Whether the connection is stale (connected but no messages for threshold).');
  lines.push('# TYPE garbanzo_connection_stale gauge');
  lines.push(`garbanzo_connection_stale ${stale ? 1 : 0}`);

  lines.push('# HELP garbanzo_connected_for_seconds Seconds since last connected (or -1).');
  lines.push('# TYPE garbanzo_connected_for_seconds gauge');
  lines.push(`garbanzo_connected_for_seconds ${connectedForSeconds}`);

  lines.push('# HELP garbanzo_last_message_ago_seconds Seconds since last message received (or -1).');
  lines.push('# TYPE garbanzo_last_message_ago_seconds gauge');
  lines.push(`garbanzo_last_message_ago_seconds ${lastMessageAgoSeconds}`);

  lines.push('# HELP garbanzo_reconnect_count Number of reconnects observed in this process lifetime.');
  lines.push('# TYPE garbanzo_reconnect_count gauge');
  lines.push(`garbanzo_reconnect_count ${state.reconnectCount}`);

  lines.push('# HELP garbanzo_memory_rss_bytes Resident set size in bytes.');
  lines.push('# TYPE garbanzo_memory_rss_bytes gauge');
  lines.push(`garbanzo_memory_rss_bytes ${mem.rss}`);

  lines.push('# HELP garbanzo_memory_heap_used_bytes Heap used in bytes.');
  lines.push('# TYPE garbanzo_memory_heap_used_bytes gauge');
  lines.push(`garbanzo_memory_heap_used_bytes ${mem.heapUsed}`);

  lines.push('# HELP garbanzo_backup_available Whether a backup file is available (best effort).');
  lines.push('# TYPE garbanzo_backup_available gauge');
  lines.push(`garbanzo_backup_available ${backupAvailable}`);

  lines.push('# HELP garbanzo_backup_integrity_ok Whether the latest backup integrity check passed (1 only when available and ok).');
  lines.push('# TYPE garbanzo_backup_integrity_ok gauge');
  lines.push(`garbanzo_backup_integrity_ok ${backupIntegrityOk}`);

  lines.push('# HELP garbanzo_whatsapp_safety_paused Whether protected WhatsApp output is paused.');
  lines.push('# TYPE garbanzo_whatsapp_safety_paused gauge');
  lines.push(`garbanzo_whatsapp_safety_paused ${whatsappSafety.paused ? 1 : 0}`);

  lines.push('# HELP garbanzo_whatsapp_outbound_held Number of retained WhatsApp outbound jobs awaiting owner action.');
  lines.push('# TYPE garbanzo_whatsapp_outbound_held gauge');
  lines.push(`garbanzo_whatsapp_outbound_held ${whatsappSafety.held}`);

  lines.push('# HELP garbanzo_whatsapp_outbound_sent_last_hour Number of protected WhatsApp sends completed in the last hour.');
  lines.push('# TYPE garbanzo_whatsapp_outbound_sent_last_hour gauge');
  lines.push(`garbanzo_whatsapp_outbound_sent_last_hour ${whatsappSafety.sentLastHour}`);

  lines.push('# HELP garbanzo_whatsapp_safety_risk_score Current WhatsApp safety middleware risk score.');
  lines.push('# TYPE garbanzo_whatsapp_safety_risk_score gauge');
  lines.push(`garbanzo_whatsapp_safety_risk_score ${whatsappSafety.score}`);

  pushLifetimeCounters(lines);
  pushDailyGauges(lines);
  await pushMemoryFactGauge(lines);
  await pushEventReminderPendingGauge(lines);
  await pushBridgeOutboxGauges(lines, now);
  await pushBridgeSummaryBufferGauges(lines);

  return lines.join('\n') + '\n';
}

async function buildHealthPayload(now: number) {
  const stale = isConnectionStale();
  const mem = process.memoryUsage();
  const backup = await getCachedBackupStatus(now);
  const whatsappSafety = await getWhatsAppSafetyMetrics(
    Math.floor((now - 60 * 60 * 1000) / 1000),
    Math.floor((now - 24 * 60 * 60 * 1000) / 1000),
  );
  const vectorStore = await getVectorStoreHealth();

  return {
    status: state.status,
    stale,
    uptime: Math.floor((now - state.startedAt) / 1000),
    connectedFor: state.connectedAt ? Math.floor((now - state.connectedAt) / 1000) : null,
    lastMessageAgo: state.lastMessageAt ? Math.floor((now - state.lastMessageAt) / 1000) : null,
    reconnectCount: state.reconnectCount,
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    backup: {
      ...backup.status,
      checkedAt: backup.checkedAt,
    },
    whatsappSafety,
    vectorStore,
  };
}

export function startHealthServer(
  port: number = 3001,
  host: string = '127.0.0.1',
  options?: HealthServerOptions,
): Server {
  server = createServer((req, res) => {
    void handleRequest(req, res, options).catch((err) => {
      logger.error({ err }, 'Health request handling failed');
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'health_handler_failed' }));
    });
  });

  server.listen(port, host, () => {
    logger.info({ port, host, url: `http://${host}:${port}/health` }, 'Health check server started');
  });

  server.on('error', (err) => {
    logger.error({ err, port }, 'Health check server error');
  });

  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options?: HealthServerOptions,
): Promise<void> {
  const metricsEnabled = options?.metricsEnabled === true;
  // The admin page carries usage/cost detail, so it is only served when a
  // token exists to gate it — never open, even on localhost binds.
  const adminEnabled = options?.adminEnabled === true && options.authToken !== undefined;

  if (options?.extraHandler?.(req, res)) return;

  // Match on the raw origin-form path (unchanged from before): absolute-form
  // request targets must not be normalized into a matching pathname.
  const rawUrl = req.url ?? '';
  const path = rawUrl.split('?')[0];

  if (path === '/bridge/inbound') {
    const bridgeInboundHandler = options?.bridgeInboundHandler;
    if (bridgeInboundHandler !== undefined) {
      await handleBridgeInbound(req, res, { ...options, bridgeInboundHandler });
      return;
    }
  }

  if (adminEnabled && (path === '/admin' || path === '/admin.json') && req.method === 'GET') {
    const now = Date.now();
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (isHealthRequestRateLimited(ip, now)) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate_limited' }));
      return;
    }

    if (!requestHasValidToken(req, options.authToken ?? '')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const snapshot = buildAdminSnapshot();
    const whatsappSafety = await getWhatsAppSafetyMetrics(
      Math.floor((now - 60 * 60 * 1000) / 1000),
      Math.floor((now - 24 * 60 * 60 * 1000) / 1000),
    );

    if (path === '/admin.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...snapshot, whatsappSafety }));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderAdminHtml(snapshot, { whatsappSafety, rawQuery: rawUrl.split('?')[1] }));
    return;
  }

  if ((path === '/health' || path === '/health/ready' || (metricsEnabled && path === '/metrics')) && req.method === 'GET') {
    const now = Date.now();
    const ip = req.socket.remoteAddress ?? 'unknown';

    if (isHealthRequestRateLimited(ip, now)) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate_limited', message: 'Too many health requests' }));
      return;
    }

    const stale = isConnectionStale();

    if (path === '/metrics') {
      const authToken = options?.authToken;
      if (authToken !== undefined && !requestHasValidToken(req, authToken)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(await renderPrometheusMetrics(now));
      return;
    }

    // `/health` is informational and always 200.
    // `/health/ready` is actionable: incoming-message inactivity alone must not fail it.
    if (path === '/health/ready') {
      const ready = state.status === 'connected';
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready, status: state.status, stale }));
      return;
    }

    const body = JSON.stringify(await buildHealthPayload(now));

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }

  res.writeHead(404);
  res.end();
}

/** Stop the local health endpoint and memory watchdog timers. */
export function stopHealthServer(): void {
  if (server) {
    server.close();
    server = null;
  }
  stopMemoryWatchdog();
  healthRateWindow.clear();
  backupStatusCache = null;
}

// ── Memory watchdog ─────────────────────────────────────────────────

const MEMORY_CHECK_INTERVAL_MS = 60_000; // every minute
const MEMORY_WARN_MB = 500;
const MEMORY_RESTART_MB = 1024;

let memoryTimer: ReturnType<typeof setInterval> | null = null;
let memoryWarned = false;

/**
 * Start periodic memory monitoring.
 * Logs warnings at 500MB RSS, forces exit at 1GB (let systemd restart).
 */
export function startMemoryWatchdog(): void {
  memoryTimer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    const rssMB = Math.round(rss / 1024 / 1024);

    if (rssMB >= MEMORY_RESTART_MB) {
      logger.fatal({ rssMB, limit: MEMORY_RESTART_MB }, 'Memory limit exceeded — restarting');
      process.exit(1); // systemd will restart the service
    }

    if (rssMB >= MEMORY_WARN_MB && !memoryWarned) {
      memoryWarned = true;
      logger.warn({ rssMB, threshold: MEMORY_WARN_MB }, 'High memory usage detected');
    } else if (rssMB < MEMORY_WARN_MB && memoryWarned) {
      memoryWarned = false; // reset if memory drops back down
    }
  }, MEMORY_CHECK_INTERVAL_MS);
  memoryTimer.unref?.();

  logger.info({ warnMB: MEMORY_WARN_MB, restartMB: MEMORY_RESTART_MB }, 'Memory watchdog started');
}

function stopMemoryWatchdog(): void {
  if (memoryTimer) {
    clearInterval(memoryTimer);
    memoryTimer = null;
  }
}

export const __testing = { buildHealthPayload, handleRequest, normalizeIp, renderPrometheusMetrics, requestHasValidToken };
