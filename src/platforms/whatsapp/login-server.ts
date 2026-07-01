import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import qrcode from 'qrcode';

import { LOGIN_PAGE_HTML } from './login-page.js';
import {
  getActiveSocket,
  getSnapshot,
  subscribe,
  type LoginSnapshot,
} from './login-store.js';

const MAX_PAIR_BODY_BYTES = 4 * 1024;

interface LoginStreamPayload {
  state: LoginSnapshot['state'];
  qrDataUrl: string | null;
}

export function createLoginRequestHandler(opts: { token: string }): (
  req: IncomingMessage,
  res: ServerResponse,
) => boolean {
  return (req, res) => {
    const url = parseRequestUrl(req);
    if (!url || !url.pathname.startsWith('/whatsapp/login')) {
      return false;
    }

    if (!isAuthorized(url.searchParams.get('token'), opts.token)) {
      writeJson(res, 401, { error: 'unauthorized' });
      return true;
    }

    void handleLoginRequest(req, res, url).catch(() => {
      if (!res.headersSent) {
        writeJson(res, 500, { error: 'internal_error' });
        return;
      }
      res.end();
    });

    return true;
  };
}

async function handleLoginRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method === 'GET' && url.pathname === '/whatsapp/login') {
    writeHtml(res, LOGIN_PAGE_HTML);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/whatsapp/login/stream') {
    await writeLoginStream(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/whatsapp/login/pair') {
    await handlePairRequest(req, res);
    return;
  }

  writeJson(res, 404, { error: 'not_found' });
}

function parseRequestUrl(req: IncomingMessage): URL | null {
  if (!req.url) return null;

  try {
    return new URL(req.url, 'http://127.0.0.1');
  } catch {
    return null;
  }
}

function isAuthorized(providedToken: string | null, expectedToken: string): boolean {
  if (providedToken === null) return false;
  if (expectedToken.length === 0) return false;

  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);
  if (provided.length !== expected.length) return false;

  return timingSafeEqual(provided, expected);
}

async function writeLoginStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let writeChain = Promise.resolve();

  const close = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    res.end();
  };

  req.on('close', close);

  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders?.();

  const enqueueSnapshot = (snapshot: LoginSnapshot): Promise<void> => {
    writeChain = writeChain
      .then(() => sendSnapshot(res, snapshot, () => closed))
      .catch(() => undefined);
    return writeChain;
  };

  await enqueueSnapshot(getSnapshot());
  if (closed) return;

  unsubscribe = subscribe((snapshot) => {
    void enqueueSnapshot(snapshot);
  });
}

async function sendSnapshot(
  res: ServerResponse,
  snapshot: LoginSnapshot,
  isClosed: () => boolean,
): Promise<void> {
  const payload = await buildStreamPayload(snapshot);
  if (isClosed()) return;

  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function buildStreamPayload(snapshot: LoginSnapshot): Promise<LoginStreamPayload> {
  return {
    state: snapshot.state,
    qrDataUrl: snapshot.qr ? await qrcode.toDataURL(snapshot.qr) : null,
  };
}

async function handlePairRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let rawBody: Buffer;
  try {
    rawBody = await readBody(req, MAX_PAIR_BODY_BYTES);
  } catch {
    writeJson(res, 413, { error: 'payload_too_large' });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf-8')) as unknown;
  } catch {
    writeJson(res, 400, { error: 'invalid_json' });
    return;
  }

  const phoneNumber = readPhoneNumber(payload);
  const digits = phoneNumber.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    writeJson(res, 400, { error: 'invalid_phone' });
    return;
  }

  const sock = getActiveSocket();
  if (!sock) {
    writeJson(res, 503, { error: 'not_ready' });
    return;
  }

  try {
    const code = await sock.requestPairingCode(digits);
    writeJson(res, 200, { code });
  } catch {
    writeJson(res, 500, { error: 'pairing_failed' });
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error('Request body too large');
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks);
}

function readPhoneNumber(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';

  const phoneNumber = (payload as { phoneNumber?: unknown }).phoneNumber;
  return typeof phoneNumber === 'string' ? phoneNumber : '';
}

function writeHtml(res: ServerResponse, body: string): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(body);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
