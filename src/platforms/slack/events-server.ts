import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { logger } from '../../middleware/logger.js';

import { createSlackAdapter } from './adapter.js';
import type { SlackTokenProvider } from './token-manager.js';
import { processSlackEvent } from './processor.js';

interface SlackEventsServerParams {
  host: string;
  port: number;
  tokenProvider: SlackTokenProvider;
  signingSecret: string;
  ownerId: string;
  botUserId?: string;
}

interface SlackUrlVerification {
  type: 'url_verification';
  challenge: string;
}

function isUrlVerification(payload: unknown): payload is SlackUrlVerification {
  if (!payload || typeof payload !== 'object') return false;
  const value = payload as Record<string, unknown>;
  return value.type === 'url_verification' && typeof value.challenge === 'string';
}

function readHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

function verifySlackSignature(
  signingSecret: string,
  body: Buffer,
  timestampHeader: string | null,
  signatureHeader: string | null,
): boolean {
  if (!timestampHeader || !signatureHeader) return false;
  const timestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestamp)) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > 60 * 5) {
    return false;
  }

  const base = `v0:${timestamp}:${body.toString('utf-8')}`;
  const digest = createHmac('sha256', signingSecret).update(base).digest('hex');
  const expected = `v0=${digest}`;

  const left = Buffer.from(expected);
  const right = Buffer.from(signatureHeader);
  if (left.length !== right.length) return false;

  return timingSafeEqual(left, right);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
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

  return Buffer.concat(chunks);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function createSlackEventsServer(params: SlackEventsServerParams): ReturnType<typeof createServer> {
  const messenger = createSlackAdapter(params.tokenProvider);

  const server = createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        writeJson(res, 400, { ok: false, error: 'Missing request URL/method' });
        return;
      }

      if (req.method === 'GET' && (req.url === '/' || req.url === '/slack/events')) {
        writeJson(res, 200, {
          ok: true,
          message: 'Slack events server is running',
          postTo: '/slack/events',
        });
        return;
      }

      if (req.method !== 'POST' || req.url !== '/slack/events') {
        writeJson(res, 404, { ok: false, error: 'Not found' });
        return;
      }

      const rawBody = await readBody(req, 512_000);
      const timestampHeader = readHeader(req, 'x-slack-request-timestamp');
      const signatureHeader = readHeader(req, 'x-slack-signature');

      const valid = verifySlackSignature(
        params.signingSecret,
        rawBody,
        timestampHeader,
        signatureHeader,
      );

      if (!valid) {
        writeJson(res, 401, { ok: false, error: 'Invalid Slack signature' });
        return;
      }

      const payload = JSON.parse(rawBody.toString('utf-8')) as unknown;

      if (isUrlVerification(payload)) {
        writeJson(res, 200, { challenge: payload.challenge });
        return;
      }

      writeJson(res, 200, { ok: true });

      void processSlackEvent(messenger, payload, {
        ownerId: params.ownerId,
        botUserId: params.botUserId,
      }).catch((err) => {
        logger.error({ err }, 'Failed to process Slack event payload');
      });
    } catch (err) {
      logger.error({ err }, 'Slack events request failed');
      writeJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(params.port, params.host, () => {
    logger.info({ host: params.host, port: params.port }, 'Slack events server listening');
  });

  return server;
}
