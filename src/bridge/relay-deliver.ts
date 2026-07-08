import type { MessagingPlatform } from '../core/messaging-platform.js';
import type { PlatformMessenger } from '../core/platform-messenger.js';
import { recordBridgeDeliveryLatency, recordBridgeHeldByOutboundSafety } from '../middleware/stats.js';
import { WhatsAppOutboundHeldError } from '../platforms/whatsapp/outbound-safety.js';
import { config } from '../utils/config.js';
import { truncate } from '../utils/formatting.js';
import type { BridgeEnvelope, BridgeOrigin } from './envelope.js';
import { translateFormatting } from './format-translate.js';
import { BridgeDeliveryDeferredError } from './transport.js';

const MAX_DISCORD_RETRY_AFTER_MS = 5_000;
const SECONDS_TO_MS = 1_000;

// Telegram enforces roughly 20 messages/minute per group (undocumented but
// widely observed limit) on top of its per-chat 429 responses. The adapter's
// send path already retries a 429 once using the server's own retry_after
// (src/platforms/telegram/adapter.ts) — that is REACTIVE and per-call, so it
// protects a single send but does nothing to stop a burst of bridge relays
// (a busy WhatsApp/Discord source relaying many messages in quick
// succession) from systematically tripping 429s against a Telegram
// destination chat. This is a conservative PROACTIVE minimum spacing
// between sends to the SAME destination chat, applied only when this
// instance's platform is Telegram — other platforms are unaffected.
const TELEGRAM_MIN_SEND_INTERVAL_MS = 3_000;

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
  // telegram/matrix (and any future platform) have no dedicated runtime yet;
  // capitalize the enum value rather than hardcoding a stale platform name.
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

export function createRelayDeliverer({
  messenger,
  platform,
  bufferEnvelope,
}: RelayDelivererOptions): { deliver(envelope: BridgeEnvelope): Promise<RelayDeliveryStatus> } {
  // Per-destination-chat "last sent at" clock, scoped to this deliverer
  // instance (one per running bridge). Only consulted when platform ===
  // 'telegram' (see sendTelegramWithPacing).
  const lastSentAtByChat = new Map<string, number>();

  return {
    async deliver(envelope: BridgeEnvelope): Promise<RelayDeliveryStatus> {
      const text = relayText(envelope, platform);
      const startedAt = Date.now();

      try {
        if (platform === 'discord') {
          await sendDiscordWithRateGuard(messenger, envelope.targetChatId, text);
        } else if (platform === 'telegram') {
          await sendTelegramWithPacing(messenger, envelope.targetChatId, text, lastSentAtByChat);
        } else if (platform === 'matrix') {
          // No proactive pacing for Matrix: homeserver limits are
          // operator-configurable, so the adapter's inline short-wait retry
          // plus this deferral (long retry_after → outbox reschedule without
          // an attempt) replace a fixed pacing interval.
          await sendMatrixWithDeferral(messenger, envelope.targetChatId, text);
        } else {
          await messenger.sendText(envelope.targetChatId, text);
        }
        recordBridgeDeliveryLatency(envelope.routeId, Date.now() - startedAt);
        return 'sent';
      } catch (err) {
        if (err instanceof WhatsAppOutboundHeldError) {
          recordBridgeHeldByOutboundSafety(envelope.routeId);
          await bufferEnvelope(envelope);
          return 'buffered';
        }
        throw err;
      }
    },
  };
}

/**
 * Build the "<who> (<platform>[ · <chatName>]): " attribution prefix from a
 * bridge origin. Shared by the delivered relay text (below) and the
 * ingest-into-context path (lifecycle.ts) so the text stored as conversation
 * context always matches what the receiving side actually saw — before this
 * was extracted, the ingest path duplicated a chatName-less version of this
 * logic and silently dropped the chat name.
 */
export function attributionPrefix(origin: BridgeOrigin): string {
  const label = platformLabel(origin.platform);
  const who = origin.senderName ?? origin.senderId;
  const prefixLabel = origin.chatName ? `${label} · ${origin.chatName}` : label;
  return `${who} (${prefixLabel}): `;
}

function relayText(envelope: BridgeEnvelope, targetPlatform: MessagingPlatform): string {
  const prefix = attributionPrefix(envelope.origin);
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

/**
 * Enforce a minimum gap since the last send to this destination chat by
 * deferring the source outbox row instead of sleeping inside the receiver's
 * delivery request. The outbox claims rows in id order and handles them
 * serially; returning a deadline lets later rows for other routes/chats drain
 * while preserving same-chat order at the claimed-row boundary. This is
 * process-local pacing, so a receiver restart can forget the last-send clock;
 * Telegram's adapter-level 429 retry remains the reactive backstop.
 */
/**
 * Matrix delivery: convert the adapter's rate-limit signal into the outbox's
 * deferral machinery. The adapter retries short waits inline and throws
 * MatrixRateLimitError (carrying the homeserver's retry_after) for longer
 * ones — sleeping through those inside a delivery would block the serial
 * outbox drain and outlive the HTTP transport's timeout.
 */
async function sendMatrixWithDeferral(
  messenger: Pick<PlatformMessenger, 'sendText'>,
  chatId: string,
  text: string,
): Promise<void> {
  const { MatrixRateLimitError } = await import('../platforms/matrix/adapter.js');
  try {
    await messenger.sendText(chatId, text);
  } catch (err) {
    if (err instanceof MatrixRateLimitError) {
      const retryAtMs = Date.now() + err.retryAfterMs;
      throw new BridgeDeliveryDeferredError(
        retryAtMs,
        `Matrix rate limit deferred until ${retryAtMs}`,
        { cause: err },
      );
    }
    throw err;
  }
}

async function sendTelegramWithPacing(
  messenger: Pick<PlatformMessenger, 'sendText'>,
  chatId: string,
  text: string,
  lastSentAtByChat: Map<string, number>,
): Promise<void> {
  const lastSentAt = lastSentAtByChat.get(chatId);
  if (lastSentAt !== undefined) {
    const retryAtMs = lastSentAt + TELEGRAM_MIN_SEND_INTERVAL_MS;
    if (Date.now() < retryAtMs) {
      throw new BridgeDeliveryDeferredError(
        retryAtMs,
        `Telegram pacing deferred until ${retryAtMs}`,
      );
    }
  }

  try {
    await messenger.sendText(chatId, text);
  } finally {
    // Recorded even on failure: a failed send still consumed a moment at
    // the chat, and NOT recording it would let a fast retry loop bypass the
    // spacing entirely on repeated errors.
    lastSentAtByChat.set(chatId, Date.now());
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
