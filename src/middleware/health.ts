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

export function startHealthServer(port: number = 3001): void {
  server = createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      const mem = process.memoryUsage();
      const now = Date.now();

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
    logger.error({ err }, 'Health check server error');
  });
}

export function stopHealthServer(): void {
  if (server) {
    server.close();
    server = null;
  }
  stopMemoryWatchdog();
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
