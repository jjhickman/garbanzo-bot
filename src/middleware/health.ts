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
import { verifyLatestBackupIntegrity, type BackupIntegrityStatus } from '../utils/db-maintenance.js';

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
  if (state.status === 'connected' && state.connectedAt !== null) {
    // Reconnection — increment counter
    state.reconnectCount++;
  }
  state.status = 'connected';
  state.connectedAt = Date.now();
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

function getCachedBackupStatus(now: number): { checkedAt: number; status: BackupIntegrityStatus } {
  if (!backupStatusCache || now - backupStatusCache.checkedAt >= BACKUP_CHECK_CACHE_MS) {
    backupStatusCache = {
      checkedAt: now,
      status: verifyLatestBackupIntegrity(),
    };
  }
  return backupStatusCache;
}

/**
 * Start the local HTTP health endpoint (`/health`) with lightweight abuse protection.
 */
export function startHealthServer(port: number = 3001): void {
  server = createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      const now = Date.now();
      const ip = req.socket.remoteAddress ?? 'unknown';

      if (isHealthRequestRateLimited(ip, now)) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'rate_limited', message: 'Too many health requests' }));
        return;
      }

      const mem = process.memoryUsage();
      const backup = getCachedBackupStatus(now);

      const body = JSON.stringify({
        status: state.status,
        stale: isConnectionStale(),
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
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info({ port, url: `http://127.0.0.1:${port}/health` }, 'Health check server started');
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
