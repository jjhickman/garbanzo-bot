/**
 * Health check HTTP endpoint + connection state tracker.
 *
 * Exposes a tiny HTTP server on localhost that returns JSON with:
 * - WhatsApp connection status (connected/disconnected/connecting)
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
  getWhatsAppSafetyMetrics,
  verifyLatestBackupIntegrity,
  type BackupIntegrityStatus,
} from '../utils/db.js';

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

/** Call when WhatsApp connection opens */
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

/** Call when WhatsApp connection closes */
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

const healthRateWindow = new Map<string, { windowStart: number; count: number }>();

const BACKUP_CHECK_CACHE_MS = 5 * 60_000;
let backupStatusCache: { checkedAt: number; status: BackupIntegrityStatus } | null = null;

interface HealthServerOptions {
  metricsEnabled?: boolean;
  authToken?: string;
  /** Serve the owner admin page at /admin (+ /admin.json). Requires authToken. */
  adminEnabled?: boolean;
  extraHandler?: (req: IncomingMessage, res: ServerResponse) => boolean;
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

async function getCachedBackupStatus(now: number): Promise<{ checkedAt: number; status: BackupIntegrityStatus }> {
  if (!backupStatusCache || now - backupStatusCache.checkedAt >= BACKUP_CHECK_CACHE_MS) {
    backupStatusCache = {
      checkedAt: now,
      status: await verifyLatestBackupIntegrity(),
    };
  }
  return backupStatusCache;
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

  lines.push('# HELP garbanzo_connection_status WhatsApp connection status as one-hot gauges.');
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

  return lines.join('\n') + '\n';
}

export function startHealthServer(
  port: number = 3001,
  host: string = '127.0.0.1',
  options?: HealthServerOptions,
): Server {
  const metricsEnabled = options?.metricsEnabled === true;
  // The admin page carries usage/cost detail, so it is only served when a
  // token exists to gate it — never open, even on localhost binds.
  const adminEnabled = options?.adminEnabled === true && options.authToken !== undefined;

  server = createServer((req, res) => {
    void (async () => {
      if (options?.extraHandler?.(req, res)) return;

      // Match on the raw origin-form path (unchanged from before): absolute-form
      // request targets must not be normalized into a matching pathname.
      const rawUrl = req.url ?? '';
      const path = rawUrl.split('?')[0];

      if (adminEnabled && (path === '/admin' || path === '/admin.json') && req.method === 'GET') {
        const now = Date.now();
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (isHealthRequestRateLimited(ip, now)) {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'rate_limited' }));
          return;
        }

        const providedToken = new URLSearchParams(rawUrl.split('?')[1] ?? '').get('token');
        if (!tokenMatches(providedToken, options.authToken ?? '')) {
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
          const providedToken = new URLSearchParams(rawUrl.split('?')[1] ?? '').get('token');
          if (authToken !== undefined && !tokenMatches(providedToken, authToken)) {
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

        const mem = process.memoryUsage();
        const backup = await getCachedBackupStatus(now);
        const whatsappSafety = await getWhatsAppSafetyMetrics(
          Math.floor((now - 60 * 60 * 1000) / 1000),
          Math.floor((now - 24 * 60 * 60 * 1000) / 1000),
        );

        const body = JSON.stringify({
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
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
        return;
      }

      res.writeHead(404);
      res.end();
    })().catch((err) => {
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

export const __testing = { normalizeIp };
