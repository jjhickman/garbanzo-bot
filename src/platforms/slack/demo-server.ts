import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';

import { createSlackDemoAdapter, type SlackDemoOutboxEntry } from './adapter.js';
import { parseSlackDemoMessage, normalizeSlackDemoInbound, processSlackDemoInbound } from './processor.js';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const DEMO_CHAT_ID = 'public-demo';
const MAX_MESSAGE_CHARS = 800;
const TURNSTILE_VERIFY_TIMEOUT_MS = 5_000;

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

type RateLimitEntry = {
  count: number;
  windowStartMs: number;
};

interface TurnstileVerifyResponse {
  success?: boolean;
  'error-codes'?: string[];
}

export function createSlackDemoServer(params: {
  host: string;
  port: number;
}): ReturnType<typeof createServer> {
  const rateLimit = new Map<string, RateLimitEntry>();

  const server = createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        writeJson(res, 400, { ok: false, error: 'Missing request URL/method' });
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;

      if (req.method === 'OPTIONS' && (path === '/' || path === '/slack/demo')) {
        writeCorsHeaders(res);
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === 'GET' && path === '/') {
        writeHtml(res, renderDemoPageHtml({
          turnstileEnabled: config.DEMO_TURNSTILE_ENABLED,
          turnstileSiteKey: config.DEMO_TURNSTILE_SITE_KEY ?? '',
        }));
        return;
      }

      if (req.method === 'GET' && path === '/slack/demo') {
        writeJson(res, 200, {
          ok: true,
          message: 'Slack demo server is running',
          postTo: '/slack/demo',
          webUi: '/',
          requiresTurnstile: config.DEMO_TURNSTILE_ENABLED,
          limits: {
            maxRequestsPerMinute: RATE_LIMIT_MAX_REQUESTS,
            maxMessageChars: MAX_MESSAGE_CHARS,
          },
          example: {
            curl: "curl -s -X POST https://demo.garbanzobot.com/slack/demo \\\n  -H 'content-type: application/json' \\\n  -d '{\"chatId\":\"public-demo\",\"senderId\":\"visitor\",\"text\":\"@garbanzo !help\",\"turnstileToken\":\"<token>\"}'",
          },
        });
        return;
      }

      if (req.method !== 'POST' || (path !== '/slack/demo' && path !== '/')) {
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

      if (config.DEMO_TURNSTILE_ENABLED) {
        const token = readTurnstileToken(body);
        if (!token) {
          writeJson(res, 403, { ok: false, error: 'Turnstile verification is required' });
          return;
        }

        const turnstileOk = await verifyTurnstileToken(token, clientIp);
        if (!turnstileOk) {
          writeJson(res, 403, { ok: false, error: 'Turnstile verification failed' });
          return;
        }
      }

      const msg = parseSlackDemoMessage(body);

      const demoSenderId = buildDemoSenderId(clientIp);
      const normalizedText = normalizeDemoText(msg.text);
      if (!normalizedText) {
        writeJson(res, 400, { ok: false, error: 'Message text is required' });
        return;
      }

      const inbound = normalizeSlackDemoInbound({
        ...msg,
        chatId: DEMO_CHAT_ID,
        senderId: demoSenderId,
        isGroupChat: true,
        text: normalizedText,
      });
      const outbox: SlackDemoOutboxEntry[] = [];
      const messenger = createSlackDemoAdapter(outbox);

      await processSlackDemoInbound(messenger, inbound, { ownerId: config.OWNER_JID });

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
      logger.error({ err, platform: 'slack', path: req.url }, 'Slack demo request failed');
      writeJson(res, 500, { ok: false, error });
    }
  });

  server.listen(params.port, params.host, () => {
    logger.info({ host: params.host, port: params.port }, 'Slack demo server listening');
  });

  return server;
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    return forwarded.split(',')[0].trim();
  }

  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].split(',')[0].trim();
  }

  return req.socket.remoteAddress ?? 'unknown';
}

function buildDemoSenderId(clientIp: string): string {
  const digest = createHash('sha256').update(clientIp).digest('hex').slice(0, 16);
  return `visitor-${digest}`;
}

function normalizeDemoText(text: string): string {
  const normalized = text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return '';
  if (normalized.length > MAX_MESSAGE_CHARS) {
    return normalized.slice(0, MAX_MESSAGE_CHARS);
  }

  return normalized;
}

function allowRequest(rateLimit: Map<string, RateLimitEntry>, clientIp: string): boolean {
  const now = Date.now();
  const current = rateLimit.get(clientIp);

  if (!current || now - current.windowStartMs > RATE_LIMIT_WINDOW_MS) {
    rateLimit.set(clientIp, { count: 1, windowStartMs: now });
    return true;
  }

  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  current.count += 1;
  return true;
}

function readTurnstileToken(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const value = (body as Record<string, unknown>).turnstileToken;
  if (typeof value !== 'string') return '';
  return value.trim();
}

async function verifyTurnstileToken(token: string, clientIp: string): Promise<boolean> {
  const secret = config.DEMO_TURNSTILE_SECRET_KEY;
  if (!secret) {
    logger.error('Turnstile is enabled but DEMO_TURNSTILE_SECRET_KEY is missing');
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURNSTILE_VERIFY_TIMEOUT_MS);

  try {
    const body = new URLSearchParams({
      secret,
      response: token,
      remoteip: clientIp,
    });

    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'Turnstile verification endpoint returned non-200');
      return false;
    }

    const json = await response.json() as TurnstileVerifyResponse;
    if (json.success) return true;

    logger.warn({ errors: json['error-codes'] ?? [] }, 'Turnstile verification rejected token');
    return false;
  } catch (err) {
    logger.warn({ err }, 'Turnstile verification failed with network/error');
    return false;
  } finally {
    clearTimeout(timeout);
  }
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

function renderDemoPageHtml(params: {
  turnstileEnabled: boolean;
  turnstileSiteKey: string;
}): string {
  const turnstileWidgetHtml = params.turnstileEnabled
    ? '<div id="turnstile-widget" style="min-height: 70px;"></div>'
    : '';
  const turnstileScriptTag = params.turnstileEnabled
    ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Garbanzo Live Demo</title>
  ${turnstileScriptTag}
  <style>
    :root {
      --bg: #f6f2ea;
      --card: #fffdf9;
      --ink: #1e1b16;
      --muted: #6b6458;
      --accent: #2f6b5f;
      --line: #e7dcc9;
    }
    body {
      margin: 0;
      font-family: "Avenir Next", "Trebuchet MS", sans-serif;
      color: var(--ink);
      background: radial-gradient(circle at 20% 10%, #fff8ea 0%, var(--bg) 45%, #eee6d8 100%);
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 20px;
    }
    .card {
      width: min(760px, 96vw);
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: 0 20px 60px rgba(33, 24, 8, 0.1);
      overflow: hidden;
    }
    .header {
      padding: 18px 20px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(140deg, #fdf0d7, #f5eee2 40%, #e7f2ef);
    }
    h1 {
      margin: 0 0 4px;
      font-size: 22px;
      line-height: 1.2;
      letter-spacing: 0.2px;
    }
    p {
      margin: 0;
      color: var(--muted);
    }
    .content {
      display: grid;
      gap: 10px;
      padding: 16px;
    }
    label {
      font-size: 13px;
      color: var(--muted);
      display: block;
      margin-bottom: 4px;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      border-radius: 10px;
      border: 1px solid var(--line);
      padding: 10px 12px;
      font: inherit;
      background: #fff;
      min-height: 92px;
      resize: vertical;
    }
    button {
      border: 0;
      border-radius: 10px;
      background: linear-gradient(120deg, var(--accent), #245147);
      color: white;
      font: inherit;
      font-weight: 600;
      padding: 10px 14px;
      cursor: pointer;
    }
    button:hover {
      filter: brightness(1.06);
    }
    .status {
      font-size: 13px;
      color: var(--muted);
      min-height: 18px;
    }
    pre {
      margin: 0;
      background: #171614;
      color: #f7f3ea;
      border-radius: 12px;
      padding: 12px;
      overflow: auto;
      max-height: 45vh;
      font-size: 12px;
    }
    .foot {
      padding: 12px 16px 16px;
      color: var(--muted);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>Garbanzo Bean Demo</h1>
      <p>Try a live chat session without installing anything.</p>
    </div>
    <div class="content">
      <div class="status">Session is anonymous and rate-limited per IP.</div>
      <div>
        <label for="text">Message</label>
        <textarea id="text">@garbanzo what can you do for meetup communities?</textarea>
      </div>
      ${turnstileWidgetHtml}
      <div>
        <button id="sendBtn">Send Message</button>
      </div>
      <div class="status" id="status">Ready</div>
      <pre id="output">{\n  "tip": "Responses will appear here"\n}</pre>
    </div>
    <div class="foot">
      Demo protection includes IP rate limits, sender normalization, and challenge validation.
    </div>
  </div>

  <script>
    const turnstileEnabled = ${params.turnstileEnabled ? 'true' : 'false'};
    const turnstileSiteKey = ${JSON.stringify(params.turnstileSiteKey)};

    const sendBtn = document.getElementById('sendBtn');
    const statusEl = document.getElementById('status');
    const outputEl = document.getElementById('output');

    let turnstileToken = '';

    function mountTurnstile() {
      if (!turnstileEnabled) return;
      if (!window.turnstile) {
        setTimeout(mountTurnstile, 200);
        return;
      }

      window.turnstile.render('#turnstile-widget', {
        sitekey: turnstileSiteKey,
        callback: function(token) {
          turnstileToken = token;
        },
        'expired-callback': function() {
          turnstileToken = '';
        },
      });
    }

    mountTurnstile();

    async function sendDemoMessage() {
      const text = document.getElementById('text').value.trim();

      if (turnstileEnabled && !turnstileToken) {
        statusEl.textContent = 'Please complete the challenge first.';
        return;
      }

      statusEl.textContent = 'Sending...';
      sendBtn.disabled = true;

      try {
        const payload = {
          chatId: 'public-demo',
          senderId: 'visitor',
          text,
          turnstileToken: turnstileEnabled ? turnstileToken : undefined,
        };

        const response = await fetch('/slack/demo', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const data = await response.json();
        outputEl.textContent = JSON.stringify(data, null, 2);

        if (!response.ok) {
          statusEl.textContent = 'Request failed';
          return;
        }

        statusEl.textContent = 'Response received';
        if (turnstileEnabled && window.turnstile) {
          window.turnstile.reset();
          turnstileToken = '';
        }
      } catch (err) {
        statusEl.textContent = 'Network error';
        outputEl.textContent = String(err);
      } finally {
        sendBtn.disabled = false;
      }
    }

    sendBtn.addEventListener('click', function() {
      void sendDemoMessage();
    });
  </script>
</body>
</html>`;
}
