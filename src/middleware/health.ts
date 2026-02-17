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
 * Also tracks connection staleness — if no messages are received
 * across any group for 30+ minutes, the connection is considered stale.
 */

import { createServer, type Server } from 'http';
import { logger } from './logger.js';
import { verifyLatestBackupIntegrity, type BackupIntegrityStatus } from '../utils/db.js';

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

function isHealthRequestRateLimited(ip: string, now: number): boolean {
  const existing = healthRateWindow.get(ip);
  if (!existing || now - existing.windowStart >= HEALTH_RATE_WINDOW_MS) {
    healthRateWindow.set(ip, { windowStart: now, count: 1 });
    return false;
  }

  existing.count += 1;
  return existing.count > HEALTH_RATE_LIMIT;
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

  return lines.join('\n') + '\n';
}

export function startHealthServer(
  port: number = 3001,
  host: string = '127.0.0.1',
  options?: { metricsEnabled?: boolean },
): void {
  const metricsEnabled = options?.metricsEnabled === true;

  server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0];

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
          res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
          res.end(await renderPrometheusMetrics(now));
          return;
        }

        // `/health` is informational and always 200.
        // `/health/ready` is actionable: 200 only when connected + not stale.
        if (path === '/health/ready') {
          const ready = state.status === 'connected' && !stale;
          res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ready, status: state.status, stale }));
          return;
        }

        const mem = process.memoryUsage();
        const backup = await getCachedBackupStatus(now);

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

  logger.info({ warnMB: MEMORY_WARN_MB, restartMB: MEMORY_RESTART_MB }, 'Memory watchdog started');
}

function stopMemoryWatchdog(): void {
  if (memoryTimer) {
    clearInterval(memoryTimer);
    memoryTimer = null;
  }
}
