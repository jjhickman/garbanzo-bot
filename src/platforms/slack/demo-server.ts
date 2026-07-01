import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';

import { renderDemoPageHtml } from './demo-page.js';
import {
  buildDemoModelConfig,
  healthPayload,
  processDemoMessage,
  resolveDemoPlatform,
} from './demo-handlers.js';
import {
  allowRequest,
  buildDemoSenderId,
  getClientIp,
  type RateLimitEntry,
  readTurnstileToken,
  verifyTurnstileToken,
} from './demo-protection.js';
import type { SlackDemoServerOptions } from './demo-types.js';

export { renderDemoPageHtml } from './demo-page.js';

export function createSlackDemoServer(
  params: {
    host: string;
    port: number;
  },
  options: SlackDemoServerOptions = {},
): ReturnType<typeof createServer> {
  const rateLimit = new Map<string, RateLimitEntry>();
  const turnstileEnabled = options.turnstileEnabled ?? config.DEMO_TURNSTILE_ENABLED;
  const turnstileSiteKey = options.turnstileSiteKey ?? config.DEMO_TURNSTILE_SITE_KEY ?? '';
  const demoModel = buildDemoModelConfig();

  const verifyTurnstile = options.verifyTurnstile ?? verifyTurnstileToken;

  const server = createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        writeJson(res, 400, { ok: false, error: 'Missing request URL/method' });
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;

      if (req.method === 'OPTIONS' && isSupportedPath(path)) {
        writeCorsHeaders(res);
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === 'GET' && path === '/') {
        writeHtml(res, renderDemoPageHtml({
          turnstileEnabled,
          turnstileSiteKey,
          demoModel,
        }));
        return;
      }

      if (req.method === 'GET' && path === '/slack/demo') {
        writeJson(res, 200, healthPayload('slack', turnstileEnabled, demoModel));
        return;
      }

      if (req.method === 'GET' && path === '/discord/demo') {
        writeJson(res, 200, healthPayload('discord', turnstileEnabled, demoModel));
        return;
      }

      if (req.method !== 'POST' || !isSupportedPostPath(path)) {
        writeJson(res, 404, { ok: false, error: 'Not found' });
        return;
      }

      const clientIp = getClientIp(req);
      if (!allowRequest(rateLimit, clientIp)) {
        writeJson(res, 429, {
          ok: false,
          error: 'Too many requests. Please wait and try again.',
        });
        return;
      }

      const body = await readJsonBody(req, 64_000);

      if (turnstileEnabled) {
        const token = readTurnstileToken(body);
        if (!token) {
          writeJson(res, 403, { ok: false, error: 'Turnstile verification is required' });
          return;
        }

        const turnstileOk = await verifyTurnstile(token, clientIp);
        if (!turnstileOk) {
          writeJson(res, 403, { ok: false, error: 'Turnstile verification failed' });
          return;
        }
      }

      const platform = resolveDemoPlatform(path, body);
      if (!platform) {
        writeJson(res, 400, { ok: false, error: 'Invalid platform. Use slack or discord.' });
        return;
      }

      const result = await processDemoMessage(platform, body, buildDemoSenderId(clientIp));

      writeJson(res, 200, {
        ok: true,
        platform,
        inbound: {
          chatId: result.inbound.chatId,
          senderId: result.inbound.senderId,
          messageId: result.inbound.messageId,
          isGroupChat: result.inbound.isGroupChat,
        },
        outbox: result.outbox,
        inference: {
          primaryProvider: demoModel.primaryProvider,
          primaryModel: demoModel.primaryModel,
          providerOrder: demoModel.providerOrder,
          modelsByProvider: demoModel.modelsByProvider,
          costProfile: demoModel.costProfile,
        },
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ err, platform: 'demo', path: req.url }, 'Demo request failed');
      writeJson(res, 500, { ok: false, error });
    }
  });

  server.listen(params.port, params.host, () => {
    logger.info({ host: params.host, port: params.port }, 'Unified demo server listening');
  });

  return server;
}

function isSupportedPath(path: string): boolean {
  return path === '/' || path === '/slack/demo' || path === '/discord/demo' || path === '/demo/chat';
}

function isSupportedPostPath(path: string): boolean {
  return path === '/demo/chat' || path === '/slack/demo' || path === '/discord/demo' || path === '/';
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`Request body too large (max ${maxBytes} bytes)`);
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function writeCorsHeaders(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.statusCode = status;
  writeCorsHeaders(res);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(json);
}

function writeHtml(res: ServerResponse, body: string): void {
  res.statusCode = 200;
  writeCorsHeaders(res);
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(body);
}
