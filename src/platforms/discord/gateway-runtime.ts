import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createPublicKey, verify } from 'node:crypto';

import { logger } from '../../middleware/logger.js';

import { createDiscordAdapter } from './adapter.js';
import { processDiscordEvent } from './processor.js';

interface DiscordGatewayRuntimeParams {
  host: string;
  port: number;
  botToken: string;
  publicKey: string;
  ownerId: string;
}

interface DiscordReadyPayload {
  user?: {
    id?: string;
    username?: string;
  };
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

function readHeader(req: IncomingMessage, headerName: string): string | null {
  const value = req.headers[headerName];
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

function verifyDiscordSignature(
  publicKeyHex: string,
  timestamp: string | null,
  signatureHex: string | null,
  body: Buffer,
): boolean {
  if (!timestamp || !signatureHex) return false;

  try {
    const keyRaw = Buffer.from(publicKeyHex, 'hex');
    if (keyRaw.length !== 32) return false;

    // DER prefix for Ed25519 public key (RFC 8410 SubjectPublicKeyInfo)
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const spkiKey = Buffer.concat([spkiPrefix, keyRaw]);
    const keyObject = createPublicKey({ key: spkiKey, format: 'der', type: 'spki' });

    const message = Buffer.concat([Buffer.from(timestamp, 'utf-8'), body]);
    const signature = Buffer.from(signatureHex, 'hex');

    return verify(null, message, keyObject, signature);
  } catch {
    return false;
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function createDiscordInteractionsServer(
  params: DiscordGatewayRuntimeParams,
): ReturnType<typeof createServer> {
  const messenger = createDiscordAdapter(params.botToken);
  let botUserId: string | undefined;

  const server = createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        writeJson(res, 400, { ok: false, error: 'Missing request URL/method' });
        return;
      }

      if (req.method === 'GET' && (req.url === '/' || req.url === '/discord/interactions')) {
        writeJson(res, 200, {
          ok: true,
          message: 'Discord interactions server is running',
          postTo: '/discord/interactions',
        });
        return;
      }

      if (req.method !== 'POST' || req.url !== '/discord/interactions') {
        writeJson(res, 404, { ok: false, error: 'Not found' });
        return;
      }

      const rawBody = await readBody(req, 512_000);
      const timestamp = readHeader(req, 'x-signature-timestamp');
      const signature = readHeader(req, 'x-signature-ed25519');

      const verified = verifyDiscordSignature(
        params.publicKey,
        timestamp,
        signature,
        rawBody,
      );

      if (!verified) {
        writeJson(res, 401, { ok: false, error: 'Invalid Discord signature' });
        return;
      }

      const payload = JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>;
      const type = Number(payload.type ?? 0);

      if (type === 1) {
        // PING
        writeJson(res, 200, { type: 1 });
        return;
      }

      // Accept interaction quickly, then process in background.
      writeJson(res, 200, {
        type: 4,
        data: {
          content: 'Got it — processing now.',
          flags: 64,
        },
      });

      const data = payload.data;
      const options = (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).options))
        ? (data as Record<string, unknown>).options as Array<Record<string, unknown>>
        : [];
      const queryOption = options.find((opt) => opt.name === 'query' && typeof opt.value === 'string');
      const query = typeof queryOption?.value === 'string' ? queryOption.value : '';

      const channelId = typeof payload.channel_id === 'string' ? payload.channel_id : null;
      const userId = typeof (payload.member as Record<string, unknown> | undefined)?.user === 'object'
        ? ((payload.member as Record<string, unknown>).user as Record<string, unknown>).id
        : (payload.user as Record<string, unknown> | undefined)?.id;

      if (!channelId || typeof userId !== 'string') {
        return;
      }

      const messageCreateLike = {
        id: typeof payload.id === 'string' ? payload.id : `interaction-${Date.now()}`,
        channel_id: channelId,
        guild_id: typeof payload.guild_id === 'string' ? payload.guild_id : undefined,
        content: query,
        author: {
          id: userId,
          bot: false,
        },
        timestamp: new Date().toISOString(),
        mentions: botUserId ? [{ id: botUserId }] : [],
        attachments: [],
      };

      await processDiscordEvent(messenger, messageCreateLike, {
        ownerId: params.ownerId,
        botUserId,
      });
    } catch (err) {
      logger.error({ err }, 'Discord interactions request failed');
      writeJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(params.port, params.host, () => {
    logger.info({ host: params.host, port: params.port }, 'Discord interactions server listening');
  });

  // Best-effort bot user lookup to improve mention parsing.
  void fetch('https://discord.com/api/v10/users/@me', {
    headers: { authorization: `Bot ${params.botToken}` },
  }).then(async (response) => {
    if (!response.ok) return;
    const me = await response.json() as DiscordReadyPayload['user'];
    if (me?.id) {
      botUserId = me.id;
      logger.info({ botUserId: me.id, botUsername: me.username }, 'Resolved Discord bot identity');
    }
  }).catch((err) => {
    logger.warn({ err }, 'Unable to resolve Discord bot identity');
  });

  return server;
}
