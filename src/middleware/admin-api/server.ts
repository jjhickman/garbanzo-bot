import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';

import {
  addAdminAuditLog,
  deleteMemoryWithAudit,
  getAllMemories,
  shareMemory,
  unshareMemory,
} from '../../utils/db.js';
import { logger } from '../logger.js';
import {
  requestHasAllowedHost,
  requestHasAllowedOrigin,
  requestHasValidAdminBearer,
} from './auth.js';
import { createDeleteNonceStore } from './nonce-store.js';

const PREVIEW_FACT_MAX_CHARS = 160;
const AUDIT_SUMMARY_MAX_CHARS = 240;

export interface AdminApiListener {
  port: number;
  stop(): Promise<void>;
}

export interface StartAdminApiOptions {
  enabled: boolean;
  token: string | undefined;
  port: number;
  bindHost: string;
  sharedMemoryEnabled: boolean;
  nonceTtlMs?: number;
  now?: () => number;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function sourceIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

export async function startAdminApiListener(
  options: StartAdminApiOptions,
): Promise<AdminApiListener | null> {
  if (!options.enabled) return null;
  if (!options.token || options.token.length < 16) {
    throw new Error('ADMIN_WRITE_TOKEN must be set to at least 16 characters when admin writes are enabled');
  }

  const now = options.now ?? Date.now;
  const nonces = createDeleteNonceStore(options.nonceTtlMs, now);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!requestHasAllowedHost(req) || !requestHasAllowedOrigin(req)) {
      writeJson(res, 403, { error: 'Forbidden' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.searchParams.has('token') || !requestHasValidAdminBearer(req, options.token as string)) {
      writeJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/memory') {
      const memories = (await getAllMemories()).map((memory) => ({
        id: memory.id,
        fact: memory.fact,
        category: memory.category,
        source: memory.source,
        createdAt: memory.created_at,
      }));
      writeJson(res, 200, { memories });
      return;
    }

    const deleteMatch = /^\/api\/memory\/(\d+)$/.exec(url.pathname);
    if (req.method === 'DELETE' && deleteMatch) {
      const id = Number(deleteMatch[1]);
      const nonce = headerValue(req, 'x-confirm-nonce');
      if (nonce) {
        const nonceResult = nonces.consume(nonce, id);
        if (nonceResult === 'expired') {
          writeJson(res, 410, { error: 'Confirmation nonce expired' });
          return;
        }
        if (nonceResult === 'invalid') {
          writeJson(res, 409, { error: 'Confirmation nonce invalid or already used' });
          return;
        }

        const memory = (await getAllMemories()).find((entry) => entry.id === id);
        if (!memory) {
          writeJson(res, 404, { error: 'Memory not found' });
          return;
        }
        const audit = {
          ts: now(),
          action: 'memory.delete',
          target: String(id),
          summary: truncate(`Memory #${id} deleted: ${memory.fact}`, AUDIT_SUMMARY_MAX_CHARS),
          sourceIp: sourceIp(req),
        };
        const deleted = await deleteMemoryWithAudit(id, audit);
        if (!deleted) {
          writeJson(res, 404, { error: 'Memory not found' });
          return;
        }
        writeJson(res, 200, { deleted: true, id });
        return;
      }

      const memory = (await getAllMemories()).find((entry) => entry.id === id);
      if (!memory) {
        writeJson(res, 404, { error: 'Memory not found' });
        return;
      }
      const issued = nonces.issue(id);
      writeJson(res, 202, {
        ...issued,
        preview: { id, fact: truncate(memory.fact, PREVIEW_FACT_MAX_CHARS) },
      });
      return;
    }

    const shareMatch = /^\/api\/memory\/(\d+)\/(share|unshare)$/.exec(url.pathname);
    if (req.method === 'POST' && shareMatch) {
      if (!options.sharedMemoryEnabled) {
        writeJson(res, 409, { error: 'Shared memory is disabled' });
        return;
      }

      const id = Number(shareMatch[1]);
      const action = shareMatch[2];
      const auditBase = {
        target: String(id),
        sourceIp: sourceIp(req),
      };
      await addAdminAuditLog({
        ...auditBase,
        ts: now(),
        action: `memory.${action}.intent`,
        summary: `Memory #${id} ${action} requested`,
      });
      let resultStatus: 'succeeded' | 'not-found' | 'failed' = 'succeeded';
      if (action === 'share') {
        const result = await shareMemory(id);
        if (result === 'not-found') resultStatus = 'not-found';
        else if (result === 'failed') resultStatus = 'failed';
      } else {
        const unshared = await unshareMemory(id);
        if (!unshared) resultStatus = 'failed';
      }

      await addAdminAuditLog({
        ...auditBase,
        ts: now(),
        action: `memory.${action}.result`,
        summary: `Memory #${id} ${action} ${resultStatus}`,
      });
      if (resultStatus === 'not-found') {
        writeJson(res, 404, { error: 'Memory not found' });
        return;
      }
      if (resultStatus === 'failed') {
        writeJson(res, 503, { error: `Memory could not be ${action}d` });
        return;
      }
      writeJson(res, 200, { id, [action === 'share' ? 'shared' : 'unshared']: true });
      return;
    }

    writeJson(res, 404, { error: 'Not found' });
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      logger.error({ err }, 'Admin memory API request failed');
      if (!res.headersSent) writeJson(res, 500, { error: 'Internal server error' });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(options.port, options.bindHost, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Admin memory API did not acquire a TCP port');
  }

  return {
    port: address.port,
    stop: async () => closeServer(server),
  };
}
