import type { MessagingPlatform } from '../core/messaging-platform.js';
import type { PlatformMessenger } from '../core/platform-messenger.js';
import { WhatsAppOutboundHeldError } from '../platforms/whatsapp/outbound-safety.js';
import { config } from '../utils/config.js';
import { truncate } from '../utils/formatting.js';
import type { BridgeEnvelope } from './envelope.js';
import { translateFormatting } from './format-translate.js';

const MAX_DISCORD_RETRY_AFTER_MS = 5_000;
const SECONDS_TO_MS = 1_000;

type RelayDelivererOptions = {
  messenger: Pick<PlatformMessenger, 'sendText'>;
  platform: MessagingPlatform;
  bufferEnvelope: (envelope: BridgeEnvelope) => Promise<void>;
};

type RelayDeliveryStatus = 'sent' | 'buffered';

export function platformLabel(platform: MessagingPlatform): string {
  if (platform === 'whatsapp') return 'WhatsApp';
  if (platform === 'discord') return 'Discord';
  if (platform === 'slack') return 'Slack';
  return 'Teams';
}

export function createRelayDeliverer({
  messenger,
  platform,
  bufferEnvelope,
}: RelayDelivererOptions): { deliver(envelope: BridgeEnvelope): Promise<RelayDeliveryStatus> } {
  return {
    async deliver(envelope: BridgeEnvelope): Promise<RelayDeliveryStatus> {
      const text = relayText(envelope, platform);

      try {
        if (platform === 'discord') {
          await sendDiscordWithRateGuard(messenger, envelope.targetChatId, text);
        } else {
          await messenger.sendText(envelope.targetChatId, text);
        }
        return 'sent';
      } catch (err) {
        if (err instanceof WhatsAppOutboundHeldError) {
          await bufferEnvelope(envelope);
          return 'buffered';
        }
        throw err;
      }
    },
  };
}

function relayText(envelope: BridgeEnvelope, targetPlatform: MessagingPlatform): string {
  const label = platformLabel(envelope.origin.platform);
  const who = envelope.origin.senderName ?? envelope.origin.senderId;
  const prefixLabel = envelope.origin.chatName ? `${label} · ${envelope.origin.chatName}` : label;
  const prefix = `${who} (${prefixLabel}): `;
  const body = envelope.kind === 'media-placeholder'
    ? envelope.text
    : translateFormatting(envelope.text, envelope.origin.platform, targetPlatform);

  const composed = `${prefix}${truncateBody(body, config.BRIDGE_MAX_TEXT - prefix.length)}`;

  // The prefix itself is attacker/user-controlled (senderName), so it can
  // alone exceed BRIDGE_MAX_TEXT even after truncateBody clamps the body to
  // an empty string. Hard-truncate the whole composed string as a backstop.
  return truncate(composed, config.BRIDGE_MAX_TEXT);
}

function truncateBody(body: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (body.length <= maxLength) return body;
  if (maxLength <= 3) return '.'.repeat(maxLength);
  return truncate(body, maxLength);
}

async function sendDiscordWithRateGuard(
  messenger: Pick<PlatformMessenger, 'sendText'>,
  chatId: string,
  text: string,
): Promise<void> {
  try {
    await messenger.sendText(chatId, text);
  } catch (err) {
    if (!isDiscordRateLimitError(err)) throw err;
    await sleep(parseDiscordRetryAfterMs(err));
    await messenger.sendText(chatId, text);
  }
}

function isDiscordRateLimitError(err: unknown): boolean {
  return discordErrorStatus(err) === 429;
}

function discordErrorStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return statusFromMessage(String(err));

  const record = err as Record<string, unknown>;
  if (typeof record.status === 'number') return record.status;
  if (typeof record.statusCode === 'number') return record.statusCode;
  if (typeof record.message === 'string') return statusFromMessage(record.message);
  return null;
}

function statusFromMessage(message: string): number | null {
  const match = /\((\d{3})\)/.exec(message);
  return match ? Number(match[1]) : null;
}

function parseDiscordRetryAfterMs(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  const body = message.slice(message.indexOf('): ') + 3);
  const fromJson = parseJsonRetryAfter(body);
  if (fromJson !== null) return fromJson;

  const fromText = /retry[-_ ]after["':=\s]+([0-9]+(?:\.[0-9]+)?)/i.exec(message);
  return parseRetryAfterValue(fromText?.[1]) ?? 0;
}

function parseJsonRetryAfter(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const retryAfter = (parsed as Record<string, unknown>).retry_after
      ?? (parsed as Record<string, unknown>).retryAfter;
    return parseRetryAfterValue(retryAfter);
  } catch {
    return null;
  }
}

function parseRetryAfterValue(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const seconds = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(Math.ceil(seconds * SECONDS_TO_MS), MAX_DISCORD_RETRY_AFTER_MS);
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
