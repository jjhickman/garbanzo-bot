import { config } from '../../utils/config.js';

import { createDiscordDemoAdapter, type DiscordDemoOutboxEntry } from '../discord/adapter.js';
import {
  parseDiscordDemoMessage,
  normalizeDiscordDemoInbound,
  processDiscordDemoInbound,
} from '../discord/processor.js';

import { createSlackDemoAdapter, type SlackDemoOutboxEntry } from './adapter.js';
import { RATE_LIMIT_MAX_REQUESTS } from './demo-protection.js';
import type { DemoModelConfig, DemoPlatform } from './demo-types.js';
import {
  parseSlackDemoMessage,
  normalizeSlackDemoInbound,
  processSlackDemoInbound,
} from './processor.js';

const MAX_MESSAGE_CHARS = 800;
const DEMO_CHAT_ID_PREFIX = 'public-demo';

type DemoOutboxEntry = SlackDemoOutboxEntry | DiscordDemoOutboxEntry;

export function parseProviderOrder(raw: string): string[] {
  return raw
    .split(',')
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean);
}

export function modelForProvider(provider: string): string {
  if (provider === 'openrouter') return config.OPENROUTER_MODEL;
  if (provider === 'anthropic') return config.ANTHROPIC_MODEL;
  if (provider === 'openai') return config.OPENAI_MODEL;
  if (provider === 'gemini') return config.GEMINI_MODEL;
  if (provider === 'bedrock') return config.BEDROCK_MODEL_ID ?? 'not configured';
  return 'unknown';
}

export function describeCostProfile(primaryModel: string): string {
  const model = primaryModel.toLowerCase();
  if (model.includes('mini') || model.includes('haiku') || model.includes('flash')) {
    return 'cost-optimized';
  }
  if (model.includes('sonnet') || model.includes('gpt-4')) {
    return 'premium';
  }
  return 'balanced';
}

export function buildDemoModelConfig(): DemoModelConfig {
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

export function healthPayload(
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

export function normalizeDemoText(text: string): string {
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

export function parseBodyPlatform(body: unknown): DemoPlatform | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as Record<string, unknown>).platform;
  if (raw === 'slack' || raw === 'discord') return raw;
  return null;
}

export function resolveDemoPlatform(path: string, body: unknown): DemoPlatform | null {
  if (path === '/slack/demo') return 'slack';
  if (path === '/discord/demo') return 'discord';
  return parseBodyPlatform(body) ?? 'slack';
}

export async function processDemoMessage(
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
    await processDiscordDemoInbound(messenger, inbound, { ownerId: config.OWNER_JID ?? '' });

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
  await processSlackDemoInbound(messenger, inbound, { ownerId: config.OWNER_JID ?? '' });

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
