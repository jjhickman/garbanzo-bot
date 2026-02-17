import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';

import { createDiscordDemoAdapter, type DiscordDemoOutboxEntry } from '../discord/adapter.js';
import {
  parseDiscordDemoMessage,
  normalizeDiscordDemoInbound,
  processDiscordDemoInbound,
} from '../discord/processor.js';

import { createSlackDemoAdapter, type SlackDemoOutboxEntry } from './adapter.js';
import {
  parseSlackDemoMessage,
  normalizeSlackDemoInbound,
  processSlackDemoInbound,
} from './processor.js';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const MAX_MESSAGE_CHARS = 800;
const TURNSTILE_VERIFY_TIMEOUT_MS = 5_000;
const DEMO_CHAT_ID_PREFIX = 'public-demo';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

type DemoPlatform = 'slack' | 'discord';
type DemoOutboxEntry = SlackDemoOutboxEntry | DiscordDemoOutboxEntry;

type RateLimitEntry = {
  count: number;
  windowStartMs: number;
};

interface TurnstileVerifyResponse {
  success?: boolean;
  'error-codes'?: string[];
}

interface SlackDemoServerOptions {
  turnstileEnabled?: boolean;
  turnstileSiteKey?: string;
  verifyTurnstile?: (token: string, clientIp: string) => Promise<boolean>;
}

interface DemoModelConfig {
  providerOrder: string[];
  primaryProvider: string;
  primaryModel: string;
  modelsByProvider: Record<string, string>;
  costProfile: string;
}

function parseProviderOrder(raw: string): string[] {
  return raw
    .split(',')
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean);
}

function modelForProvider(provider: string): string {
  if (provider === 'openrouter') return config.OPENROUTER_MODEL;
  if (provider === 'anthropic') return config.ANTHROPIC_MODEL;
  if (provider === 'openai') return config.OPENAI_MODEL;
  if (provider === 'gemini') return config.GEMINI_MODEL;
  if (provider === 'bedrock') return config.BEDROCK_MODEL_ID ?? 'not configured';
  return 'unknown';
}

function describeCostProfile(primaryModel: string): string {
  const model = primaryModel.toLowerCase();
  if (model.includes('mini') || model.includes('haiku') || model.includes('flash')) {
    return 'cost-optimized';
  }
  if (model.includes('sonnet') || model.includes('gpt-4')) {
    return 'premium';
  }
  return 'balanced';
}

function buildDemoModelConfig(): DemoModelConfig {
  const providerOrder = parseProviderOrder(config.AI_PROVIDER_ORDER);
  const primaryProvider = providerOrder[0] ?? 'openrouter';

  const modelsByProvider: Record<string, string> = {};
  for (const provider of providerOrder) {
    modelsByProvider[provider] = modelForProvider(provider);
  }

  const primaryModel = modelsByProvider[primaryProvider] ?? modelForProvider(primaryProvider);

  return {
    providerOrder,
    primaryProvider,
    primaryModel,
    modelsByProvider,
    costProfile: describeCostProfile(primaryModel),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

function healthPayload(
  platform: DemoPlatform,
  turnstileEnabled: boolean,
  demoModel: DemoModelConfig,
): Record<string, unknown> {
  return {
    ok: true,
    platform,
    message: `${platform[0].toUpperCase() + platform.slice(1)} demo server is running`,
    postTo: '/demo/chat',
    webUi: '/',
    requiresTurnstile: turnstileEnabled,
    limits: {
      maxRequestsPerMinute: RATE_LIMIT_MAX_REQUESTS,
      maxMessageChars: MAX_MESSAGE_CHARS,
    },
    inference: {
      primaryProvider: demoModel.primaryProvider,
      primaryModel: demoModel.primaryModel,
      providerOrder: demoModel.providerOrder,
      modelsByProvider: demoModel.modelsByProvider,
      costProfile: demoModel.costProfile,
    },
    example: {
      curl: "curl -s -X POST https://demo.garbanzobot.com/demo/chat \\\n  -H 'content-type: application/json' \\\n  -d '{\"platform\":\"slack\",\"text\":\"@garbanzo !help\",\"turnstileToken\":\"<token>\"}'",
    },
  };
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

function parseBodyPlatform(body: unknown): DemoPlatform | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as Record<string, unknown>).platform;
  if (raw === 'slack' || raw === 'discord') return raw;
  return null;
}

function resolveDemoPlatform(path: string, body: unknown): DemoPlatform | null {
  if (path === '/slack/demo') return 'slack';
  if (path === '/discord/demo') return 'discord';
  return parseBodyPlatform(body) ?? 'slack';
}

async function processDemoMessage(
  platform: DemoPlatform,
  body: unknown,
  senderId: string,
): Promise<{ inbound: { chatId: string; senderId: string; messageId: string; isGroupChat: boolean }; outbox: DemoOutboxEntry[] }> {
  const source = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const basePayload = {
    chatId: DEMO_CHAT_ID_PREFIX,
    senderId,
    text: typeof source.text === 'string' ? source.text : '',
    isGroupChat: true,
    threadId: typeof source.threadId === 'string' ? source.threadId : undefined,
  };

  if (platform === 'discord') {
    const msg = parseDiscordDemoMessage(basePayload);
    const normalizedText = normalizeDemoText(msg.text);
    if (!normalizedText) {
      throw new Error('Message text is required');
    }

    const inbound = normalizeDiscordDemoInbound({
      ...msg,
      chatId: `discord-${DEMO_CHAT_ID_PREFIX}`,
      senderId,
      isGroupChat: true,
      text: normalizedText,
    });

    const outbox: DiscordDemoOutboxEntry[] = [];
    const messenger = createDiscordDemoAdapter(outbox);
    await processDiscordDemoInbound(messenger, inbound, { ownerId: config.OWNER_JID });

    return {
      inbound: {
        chatId: inbound.chatId,
        senderId: inbound.senderId,
        messageId: inbound.messageId ?? `discord-demo-${Date.now()}`,
        isGroupChat: inbound.isGroupChat,
      },
      outbox,
    };
  }

  const msg = parseSlackDemoMessage(basePayload);
  const normalizedText = normalizeDemoText(msg.text);
  if (!normalizedText) {
    throw new Error('Message text is required');
  }

  const inbound = normalizeSlackDemoInbound({
    ...msg,
    chatId: `slack-${DEMO_CHAT_ID_PREFIX}`,
    senderId,
    isGroupChat: true,
    text: normalizedText,
  });

  const outbox: SlackDemoOutboxEntry[] = [];
  const messenger = createSlackDemoAdapter(outbox);
  await processSlackDemoInbound(messenger, inbound, { ownerId: config.OWNER_JID });

  return {
    inbound: {
      chatId: inbound.chatId,
      senderId: inbound.senderId,
      messageId: inbound.messageId ?? `slack-demo-${Date.now()}`,
      isGroupChat: inbound.isGroupChat,
    },
    outbox,
  };
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

export function renderDemoPageHtml(params: {
  turnstileEnabled: boolean;
  turnstileSiteKey: string;
  demoModel: DemoModelConfig;
}): string {
  const turnstileWidgetHtml = params.turnstileEnabled
    ? '<div id="turnstile-widget" class="turnstile-slot"></div>'
    : '';
  const turnstileScriptTag = params.turnstileEnabled
    ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
    : '';

  const modelProviderLabel = params.demoModel.primaryProvider.toUpperCase();
  const modelNameLabel = escapeHtml(params.demoModel.primaryModel);
  const costProfileLabel = escapeHtml(params.demoModel.costProfile);
  const providerOrderLabel = escapeHtml(params.demoModel.providerOrder.join(' -> '));
  const modelMapLabel = escapeHtml(
    params.demoModel.providerOrder
      .map((provider) => `${provider}:${params.demoModel.modelsByProvider[provider] ?? 'unknown'}`)
      .join(' | '),
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Garbanzo Live Demo</title>
  <meta name="description" content="Interactive Garbanzo demo with Slack and Discord behavior switching." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Bricolage+Grotesque:wght@600;700&display=swap" rel="stylesheet" />
  ${turnstileScriptTag}
  <style>
    :root {
      --bg: #eef4ef;
      --paper: #ffffff;
      --ink: #1b2222;
      --muted: #5a6a66;
      --line: #d3ddd8;
      --green-1: #1f7a64;
      --green-2: #145847;
      --purple-1: #5e5dbd;
      --purple-2: #4341a5;
      --chip: #f2f7f4;
      --warn: #855219;
      --error: #982f2f;
      --radius-lg: 20px;
      --radius-md: 12px;
      --shadow: 0 12px 36px rgba(14, 33, 28, 0.12);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Manrope", "Avenir Next", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(900px 500px at 0% 0%, #ddefe6 0%, transparent 65%),
        radial-gradient(700px 500px at 100% 100%, #f3dfce 0%, transparent 60%),
        linear-gradient(135deg, #edf4ee 0%, #f8f3ea 100%);
      padding: 22px;
    }

    .app {
      max-width: 1180px;
      margin: 0 auto;
      display: grid;
      gap: 14px;
    }

    .hero {
      border: 1px solid #bfd5cb;
      border-radius: var(--radius-lg);
      background: linear-gradient(150deg, #f8fffb 0%, #e6f3ec 58%, #faf0e1 100%);
      box-shadow: var(--shadow);
      padding: 16px 18px;
      display: grid;
      gap: 10px;
      animation: fadeUp 280ms ease both;
    }

    .hero h1 {
      margin: 0;
      font-family: "Bricolage Grotesque", "Avenir Next", sans-serif;
      font-size: clamp(1.35rem, 2.8vw, 2rem);
      letter-spacing: -0.02em;
    }

    .hero p {
      margin: 0;
      color: var(--muted);
      max-width: 70ch;
    }

    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .badge {
      border: 1px solid #bfd8cf;
      border-radius: 999px;
      font-size: 0.76rem;
      font-weight: 700;
      color: #245b4e;
      background: rgba(255, 255, 255, 0.78);
      padding: 6px 10px;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(260px, 0.6fr);
      gap: 14px;
    }

    .panel,
    .card {
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      background: var(--paper);
      box-shadow: 0 6px 20px rgba(15, 32, 28, 0.08);
    }

    .chat-head {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      background: #fbfffd;
    }

    .chat-head strong { font-size: 0.96rem; }

    .platform-switch {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .platform-btn {
      border: 1px solid #c9d7d1;
      border-radius: 999px;
      background: #f6faf8;
      color: #315952;
      font: inherit;
      font-size: 0.78rem;
      font-weight: 700;
      padding: 6px 10px;
      cursor: pointer;
      transition: transform 100ms ease, box-shadow 100ms ease;
    }

    .platform-btn.active[data-platform="slack"] {
      border-color: #2e8b73;
      background: #e7f6ef;
      color: #155746;
    }

    .platform-btn.active[data-platform="discord"] {
      border-color: #6667d2;
      background: #ededff;
      color: #2e2f83;
    }

    .platform-btn:hover { transform: translateY(-1px); }

    .feed {
      min-height: 290px;
      max-height: 440px;
      overflow: auto;
      padding: 14px;
      display: grid;
      gap: 9px;
      background:
        radial-gradient(200px 90px at 0% 0%, #f0f8f3 0%, transparent 80%),
        radial-gradient(200px 90px at 100% 100%, #f8eedd 0%, transparent 80%),
        #fcfbf7;
    }

    .bubble {
      max-width: min(92%, 620px);
      border-radius: 12px;
      padding: 10px 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.92rem;
      animation: popIn 180ms ease both;
    }

    .bubble.user {
      justify-self: end;
      border: 1px solid #c6d8d1;
      background: #e6f4ee;
    }

    .bubble.assistant {
      justify-self: start;
      border: 1px solid #cbdbd3;
      background: #f8fffb;
    }

    .bubble.system {
      justify-self: center;
      border: 1px dashed #d8c4a8;
      background: #fff7eb;
      color: #6f4d28;
      font-size: 0.84rem;
    }

    .composer {
      border-top: 1px solid var(--line);
      padding: 12px 14px 14px;
      display: grid;
      gap: 9px;
      background: #fffdfa;
    }

    .chips { display: flex; flex-wrap: wrap; gap: 7px; }

    .chip {
      border: 1px solid #ccdad4;
      border-radius: 999px;
      background: var(--chip);
      color: #2a5a50;
      font: inherit;
      font-size: 0.76rem;
      font-weight: 700;
      padding: 6px 9px;
      cursor: pointer;
    }

    textarea {
      width: 100%;
      min-height: 84px;
      border: 1px solid #cad7d2;
      border-radius: 11px;
      background: #fff;
      color: var(--ink);
      padding: 10px 11px;
      font: inherit;
      resize: vertical;
    }

    .meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 0.78rem;
    }

    .turnstile-slot {
      min-height: 64px;
      display: flex;
      align-items: center;
    }

    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }

    .btn {
      border: 0;
      border-radius: 10px;
      font: inherit;
      font-weight: 700;
      padding: 9px 13px;
      cursor: pointer;
    }

    .btn.send {
      background: linear-gradient(130deg, var(--green-1), var(--green-2));
      color: #edfff7;
    }

    .platform-slack .btn.send {
      background: linear-gradient(130deg, var(--green-1), var(--green-2));
    }

    .platform-discord .btn.send {
      background: linear-gradient(130deg, var(--purple-1), var(--purple-2));
    }

    .btn.clear {
      border: 1px solid #d4ddd8;
      background: #f8faf9;
      color: #32564e;
    }

    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .status {
      min-height: 18px;
      font-size: 0.82rem;
      color: var(--muted);
    }

    .status.ok { color: #1f6a58; }
    .status.warn { color: var(--warn); }
    .status.error { color: var(--error); }

    .side {
      display: grid;
      gap: 11px;
      align-content: start;
    }

    .card {
      padding: 12px 13px;
    }

    .card h2,
    .card h3 {
      margin: 0 0 8px;
      font-size: 1rem;
      font-family: "Bricolage Grotesque", "Avenir Next", sans-serif;
    }

    .card p,
    .card li {
      margin: 0;
      color: var(--muted);
      font-size: 0.9rem;
      line-height: 1.45;
    }

    .card ul {
      margin: 0;
      padding-left: 17px;
      display: grid;
      gap: 6px;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px;
    }

    .metric {
      border: 1px solid #dbe5df;
      border-radius: 9px;
      background: #f8fcfa;
      padding: 7px 8px;
    }

    .metric span {
      display: block;
      font-size: 0.71rem;
      color: var(--muted);
      margin-bottom: 2px;
    }

    .metric strong {
      font-size: 0.9rem;
      color: #285449;
    }

    details {
      border: 1px solid #d7e2dc;
      border-radius: 10px;
      overflow: hidden;
      background: #f6faf8;
    }

    summary {
      cursor: pointer;
      padding: 9px 11px;
      font-size: 0.82rem;
      font-weight: 700;
      color: #2b4f47;
    }

    pre {
      margin: 0;
      border-top: 1px solid #d7e2dc;
      background: #122028;
      color: #ddf3e8;
      max-height: 280px;
      overflow: auto;
      padding: 10px;
      font-size: 0.74rem;
      line-height: 1.42;
    }

    .foot {
      text-align: center;
      color: #65746f;
      font-size: 0.81rem;
      padding: 4px;
    }

    .foot a {
      color: #2f705f;
      font-weight: 700;
      text-decoration: none;
    }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes popIn {
      from { opacity: 0; transform: translateY(3px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @media (max-width: 980px) {
      .layout { grid-template-columns: 1fr; }
      .feed { min-height: 250px; max-height: 360px; }
    }
  </style>
</head>
<body class="platform-slack">
  <main class="app">
    <header class="hero">
      <h1>Garbanzo Messaging Demo</h1>
      <p>One live demo app, switchable behavior profiles for Slack and Discord.</p>
      <div class="badges">
        <span class="badge">Single demo service</span>
        <span class="badge">Slack + Discord behavior modes</span>
        <span class="badge">Primary model: ${modelProviderLabel} ${modelNameLabel}</span>
        <span class="badge">Cost profile: ${costProfileLabel}</span>
      </div>
    </header>

    <section class="layout">
      <article class="panel">
        <div class="chat-head">
          <strong>Interactive transcript</strong>
          <div class="platform-switch" role="tablist" aria-label="Demo platform mode">
            <button id="platformSlack" class="platform-btn active" data-platform="slack" type="button">Slack mode</button>
            <button id="platformDiscord" class="platform-btn" data-platform="discord" type="button">Discord mode</button>
          </div>
        </div>

        <div id="chatFeed" class="feed" aria-live="polite">
          <div class="bubble assistant">Hey - I am Garbanzo. Pick a platform mode and ask how I would help your community.</div>
        </div>

        <div class="composer">
          <div id="promptChips" class="chips"></div>

          <textarea id="text" maxlength="800">@garbanzo what can you do for meetup communities?</textarea>

          <div class="meta">
            <span id="modeHint">Slack mode: @garbanzo and !commands are supported.</span>
            <span id="charCounter">0 / 800</span>
          </div>

          ${turnstileWidgetHtml}

          <div class="actions">
            <button id="sendBtn" class="btn send" type="button">Send message</button>
            <button id="clearBtn" class="btn clear" type="button">Clear transcript</button>
          </div>

          <div id="status" class="status">Ready</div>
        </div>
      </article>

      <aside class="side">
        <section class="card">
          <h2>Model transparency</h2>
          <ul>
            <li><strong>Primary provider:</strong> ${modelProviderLabel}</li>
            <li><strong>Primary model:</strong> ${modelNameLabel}</li>
            <li><strong>Provider order:</strong> ${providerOrderLabel}</li>
            <li><strong>Configured models:</strong> ${modelMapLabel}</li>
          </ul>
        </section>

        <section class="card">
          <h2>Platform behavior differences</h2>
          <ul>
            <li>Slack mode emphasizes threaded replies and channel phrasing.</li>
            <li>Discord mode emphasizes interaction-like patterns and Discord formatting.</li>
            <li>Both run through the same routing + feature pipeline.</li>
          </ul>
        </section>

        <section class="card">
          <h3>Session metrics</h3>
          <div class="metrics">
            <div class="metric"><span>Messages</span><strong id="metricMessages">0</strong></div>
            <div class="metric"><span>Responses</span><strong id="metricResponses">0</strong></div>
            <div class="metric"><span>Last latency</span><strong id="metricLatency">--</strong></div>
            <div class="metric"><span>Current mode</span><strong id="metricMode">Slack</strong></div>
          </div>
        </section>

        <section class="card">
          <details>
            <summary>Raw response payload</summary>
            <pre id="rawOutput">{\n  "tip": "Structured response data appears here"\n}</pre>
          </details>
        </section>
      </aside>
    </section>

    <footer class="foot">
      Need implementation details? <a href="https://github.com/jjhickman/garbanzo-bot" target="_blank" rel="noreferrer">GitHub</a>
      · <a href="https://github.com/jjhickman/garbanzo-bot/blob/main/docs/AWS.md" target="_blank" rel="noreferrer">AWS docs</a>
    </footer>
  </main>

  <script>
    const turnstileEnabled = ${params.turnstileEnabled ? 'true' : 'false'};
    const turnstileSiteKey = ${JSON.stringify(params.turnstileSiteKey)};

    const platformSlackBtn = document.getElementById('platformSlack');
    const platformDiscordBtn = document.getElementById('platformDiscord');
    const sendBtn = document.getElementById('sendBtn');
    const clearBtn = document.getElementById('clearBtn');
    const statusEl = document.getElementById('status');
    const rawOutputEl = document.getElementById('rawOutput');
    const chatFeedEl = document.getElementById('chatFeed');
    const textEl = document.getElementById('text');
    const charCounterEl = document.getElementById('charCounter');
    const modeHintEl = document.getElementById('modeHint');
    const metricMessagesEl = document.getElementById('metricMessages');
    const metricResponsesEl = document.getElementById('metricResponses');
    const metricLatencyEl = document.getElementById('metricLatency');
    const metricModeEl = document.getElementById('metricMode');
    const promptChipsEl = document.getElementById('promptChips');

    const promptMap = {
      slack: [
        '@garbanzo summarize this community focus in one paragraph.',
        '@garbanzo draft a meetup reminder for tomorrow evening.',
        '@garbanzo what moderation safeguards do you apply?',
      ],
      discord: [
        '@garbanzo give me a discord-style announcement for our next meetup.',
        '@garbanzo how should we structure channels for onboarding?',
        '@garbanzo propose lightweight moderation policy bullet points.',
      ],
    };

    let activePlatform = 'slack';
    let turnstileToken = '';
    let messageCount = 0;
    let responseCount = 0;

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

    function setStatus(text, tone) {
      statusEl.textContent = text;
      statusEl.className = 'status ' + (tone || '');
    }

    function updateCounter() {
      charCounterEl.textContent = String(textEl.value.length) + ' / 800';
    }

    function updateMetrics(latencyMs) {
      metricMessagesEl.textContent = String(messageCount);
      metricResponsesEl.textContent = String(responseCount);
      metricModeEl.textContent = activePlatform === 'slack' ? 'Slack' : 'Discord';
      if (typeof latencyMs === 'number' && Number.isFinite(latencyMs)) {
        metricLatencyEl.textContent = String(Math.max(1, Math.round(latencyMs))) + ' ms';
      }
    }

    function appendBubble(role, text) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble ' + role;
      bubble.textContent = text;
      chatFeedEl.appendChild(bubble);
      chatFeedEl.scrollTop = chatFeedEl.scrollHeight;
      return bubble;
    }

    function normalizePlatform(value) {
      if (value === 'discord') return 'discord';
      return 'slack';
    }

    function applyPlatform(platform) {
      activePlatform = normalizePlatform(platform);
      document.body.classList.remove('platform-slack', 'platform-discord');
      document.body.classList.add(activePlatform === 'slack' ? 'platform-slack' : 'platform-discord');

      platformSlackBtn.classList.toggle('active', activePlatform === 'slack');
      platformDiscordBtn.classList.toggle('active', activePlatform === 'discord');

      modeHintEl.textContent = activePlatform === 'slack'
        ? 'Slack mode: @garbanzo and !commands are supported.'
        : 'Discord mode: @garbanzo and !commands are supported.';

      renderPromptChips();
      updateMetrics();
      setStatus('Ready', '');
    }

    function renderPromptChips() {
      const prompts = promptMap[activePlatform] || [];
      promptChipsEl.innerHTML = '';
      for (const prompt of prompts) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.textContent = prompt;
        chip.dataset.prompt = prompt;
        promptChipsEl.appendChild(chip);
      }
    }

    function formatOutboxEntry(entry) {
      if (!entry || typeof entry !== 'object') return '';

      if (entry.type === 'text') {
        const payload = entry.payload;
        if (payload && typeof payload === 'object' && typeof payload.text === 'string') {
          return payload.text;
        }
        return '';
      }

      if (entry.type === 'poll') {
        const payload = entry.payload;
        if (!payload || typeof payload !== 'object') return '';

        const name = typeof payload.name === 'string' ? payload.name : 'Poll';
        const values = Array.isArray(payload.values) ? payload.values : [];
        const lines = [name];
        for (let i = 0; i < values.length; i += 1) {
          const value = values[i];
          if (typeof value === 'string') lines.push(String(i + 1) + '. ' + value);
        }
        return lines.join(String.fromCharCode(10));
      }

      if (entry.type === 'document') {
        const payload = entry.payload;
        const fileName = payload && typeof payload === 'object' && typeof payload.fileName === 'string'
          ? payload.fileName
          : 'document';
        return 'Generated file: ' + fileName;
      }

      if (entry.type === 'audio') {
        return 'Generated audio response.';
      }

      return '';
    }

    function resetTurnstileAfterSend() {
      if (!turnstileEnabled || !window.turnstile) return;
      window.turnstile.reset();
      turnstileToken = '';
    }

    async function sendDemoMessage() {
      const text = textEl.value.trim();
      if (!text) {
        setStatus('Write a message first.', 'warn');
        return;
      }

      if (turnstileEnabled && !turnstileToken) {
        setStatus('Please complete the challenge first.', 'warn');
        return;
      }

      messageCount += 1;
      updateMetrics();
      appendBubble('user', '[' + activePlatform + '] ' + text);

      const typingBubble = appendBubble('system', (activePlatform === 'slack' ? 'Slack' : 'Discord') + ' mode processing...');
      setStatus('Sending request...', '');
      sendBtn.disabled = true;
      const startedAt = performance.now();

      try {
        const payload = {
          platform: activePlatform,
          chatId: 'public-demo',
          senderId: 'visitor',
          text,
          turnstileToken: turnstileEnabled ? turnstileToken : undefined,
        };

        const response = await fetch('/demo/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const data = await response.json();
        rawOutputEl.textContent = JSON.stringify(data, null, 2);
        typingBubble.remove();

        if (!response.ok || !data || data.ok !== true) {
          const errorText = data && typeof data.error === 'string' ? data.error : 'Request failed';
          appendBubble('system', errorText);
          setStatus('Request failed', 'error');
          updateMetrics(performance.now() - startedAt);
          return;
        }

        const outbox = Array.isArray(data.outbox) ? data.outbox : [];
        let rendered = 0;
        for (const entry of outbox) {
          const message = formatOutboxEntry(entry);
          if (!message) continue;
          appendBubble('assistant', '[' + activePlatform + '] ' + message);
          rendered += 1;
        }

        if (rendered === 0) {
          appendBubble('assistant', '[' + activePlatform + '] No rendered payload returned for this turn.');
        } else {
          responseCount += rendered;
        }

        updateMetrics(performance.now() - startedAt);
        setStatus('Response received', 'ok');
        resetTurnstileAfterSend();
      } catch (err) {
        typingBubble.remove();
        appendBubble('system', String(err));
        setStatus('Network error', 'error');
      } finally {
        sendBtn.disabled = false;
      }
    }

    function clearTranscript() {
      chatFeedEl.innerHTML = '';
      appendBubble('assistant', 'Transcript cleared. Ask another question to continue.');
      rawOutputEl.textContent = JSON.stringify({ tip: 'Structured response data appears here' }, null, 2);
      messageCount = 0;
      responseCount = 0;
      updateMetrics();
      setStatus('Ready', '');
    }

    promptChipsEl.addEventListener('click', function(event) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.classList.contains('chip')) return;
      const prompt = target.dataset.prompt;
      if (!prompt) return;
      textEl.value = prompt;
      updateCounter();
      textEl.focus();
    });

    platformSlackBtn.addEventListener('click', function() {
      applyPlatform('slack');
    });

    platformDiscordBtn.addEventListener('click', function() {
      applyPlatform('discord');
    });

    sendBtn.addEventListener('click', function() {
      void sendDemoMessage();
    });

    clearBtn.addEventListener('click', function() {
      clearTranscript();
    });

    textEl.addEventListener('input', updateCounter);
    textEl.addEventListener('keydown', function(event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void sendDemoMessage();
      }
    });

    mountTurnstile();
    applyPlatform('slack');
    updateCounter();
  </script>
</body>
</html>`;
}
