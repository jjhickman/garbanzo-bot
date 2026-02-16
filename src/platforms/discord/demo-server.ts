import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';

import { createDiscordDemoAdapter, type DiscordDemoOutboxEntry } from './adapter.js';
import {
  parseDiscordDemoMessage,
  normalizeDiscordDemoInbound,
  processDiscordDemoInbound,
} from './processor.js';

export function createDiscordDemoServer(params: {
  host: string;
  port: number;
}): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        writeJson(res, 400, { ok: false, error: 'Missing request URL/method' });
        return;
      }

      if (req.method === 'GET' && (req.url === '/' || req.url === '/discord/demo')) {
        writeJson(res, 200, {
          ok: true,
          message: 'Discord demo server is running',
          postTo: '/discord/demo',
          example: {
            curl: "curl -s -X POST http://127.0.0.1:" + params.port + "/discord/demo \\\n  -H 'content-type: application/json' \\\n  -d '{\"chatId\":\"C123\",\"senderId\":\"U123\",\"text\":\"@garbanzo !help\"}' | jq",
          },
        });
        return;
      }

      if (req.method !== 'POST' || req.url !== '/discord/demo') {
        writeJson(res, 404, { ok: false, error: 'Not found' });
        return;
      }

      const body = await readJsonBody(req, 256_000);
      const msg = parseDiscordDemoMessage(body);

      const inbound = normalizeDiscordDemoInbound(msg);
      const outbox: DiscordDemoOutboxEntry[] = [];
      const messenger = createDiscordDemoAdapter(outbox);

      await processDiscordDemoInbound(messenger, inbound, { ownerId: config.OWNER_JID });

      writeJson(res, 200, {
        ok: true,
        inbound: {
          chatId: inbound.chatId,
          senderId: inbound.senderId,
          messageId: inbound.messageId,
          isGroupChat: inbound.isGroupChat,
        },
        outbox,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ err, platform: 'discord', path: req.url }, 'Discord demo request failed');
      writeJson(res, 500, { ok: false, error });
    }
  });

  server.listen(params.port, params.host, () => {
    logger.info({ host: params.host, port: params.port }, 'Discord demo server listening');
  });

  return server;
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

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(json);
}
