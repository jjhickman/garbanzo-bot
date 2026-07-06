/**
 * Summary buffer + flusher — the rate-safe WhatsApp relay mode.
 *
 * Unlike `relay-deliver.ts` (send-immediately, buffer only on WhatsApp
 * backpressure), this mode NEVER sends on receipt: every inbound envelope for
 * a route is appended to `bridge_buffer` and a periodic flusher composes ONE
 * digest message per route per interval. That single-send-per-route-per-tick
 * invariant is the anti-ban guarantee — WhatsApp sees at most one outbound
 * message per route every `intervalMinutes`, no matter how chatty the
 * bridged side is.
 *
 * Deterministic, no LLM call (mirrors `buildWeeklyRecap`). All bridge_buffer
 * reads/writes go through the injected `ops` (mirroring the bridge_outbox
 * pattern) — this module never imports the db barrel or a sqlite/postgres
 * module directly, so a caller can construct it entirely with fake ops in
 * tests. (Importing `WhatsAppOutboundHeldError` from outbound-safety.ts does
 * transitively load the real db barrel, exactly as it does for
 * relay-deliver.ts — that's an existing, accepted wrinkle of catching that
 * specific error type, not something this module's own logic depends on.)
 */

import type { DbBackend } from '../utils/db-backend.js';
import type { MessagingPlatform } from '../core/messaging-platform.js';
import { logger } from '../middleware/logger.js';
import { WhatsAppOutboundHeldError } from '../platforms/whatsapp/outbound-safety.js';
import { config } from '../utils/config.js';
import { truncate } from '../utils/formatting.js';
import { parseBridgeEnvelope, type BridgeEnvelope } from './envelope.js';
import { translateFormatting } from './format-translate.js';
import { platformLabel } from './relay-deliver.js';

const EARLIER_MESSAGES_LOUD_THRESHOLD = 10;
const MINUTE_MS = 60_000;

export type BridgeBufferOps = Pick<
  DbBackend,
  | 'appendBridgeBuffer'
  | 'takeBridgeBuffer'
  | 'restoreBridgeBuffer'
  | 'bridgeBufferDepths'
>;

export interface SummaryBufferOptions {
  sendText: (chatId: string, text: string) => Promise<void>;
  targetChatIdForRoute: (routeId: string) => string | null;
  targetPlatformForRoute: (routeId: string) => MessagingPlatform | null;
  ops: BridgeBufferOps;
  intervalMinutes?: number;
  maxText?: number;
}

export interface SummaryBuffer {
  bufferEnvelope(envelope: BridgeEnvelope): Promise<void>;
  start(): void;
  stop(): void;
  depths(): Promise<Record<string, number>>;
}

function safeParseEnvelope(envelopeJson: string): BridgeEnvelope | null {
  try {
    return parseBridgeEnvelope(JSON.parse(envelopeJson) as unknown);
  } catch {
    return null;
  }
}

function envelopeLine(envelope: BridgeEnvelope, targetPlatform: MessagingPlatform): string {
  const who = envelope.origin.senderName ?? envelope.origin.senderId;
  const body = envelope.kind === 'media-placeholder'
    ? envelope.text
    : translateFormatting(envelope.text, envelope.origin.platform, targetPlatform);
  return `• ${who}: ${body}`;
}

/**
 * Compose the single digest string for a route's flush, truncating to
 * maxText by dropping the OLDEST lines first (a `… (+N earlier messages)`
 * marker replaces them) until it fits. If even the header plus marker alone
 * would overflow, falls back to a hard character truncation as a last
 * resort — the flusher must always produce exactly one sendable string.
 */
function buildDigestText(header: string, lines: string[], maxText: number): string {
  let remaining = lines;
  let dropped = 0;

  while (true) {
    const marker = dropped > 0 ? [`… (+${dropped} earlier messages)`] : [];
    const text = [header, ...marker, ...remaining].join('\n');
    if (text.length <= maxText || remaining.length === 0) {
      return text.length <= maxText ? text : truncate(text, maxText);
    }
    remaining = remaining.slice(1);
    dropped += 1;
  }
}

export function createSummaryBuffer(options: SummaryBufferOptions): SummaryBuffer {
  const intervalMinutes = options.intervalMinutes ?? config.BRIDGE_SUMMARY_INTERVAL_MINUTES;
  const maxText = options.maxText ?? config.BRIDGE_MAX_TEXT;
  const consecutiveFailures = new Map<string, number>();

  let timer: ReturnType<typeof setInterval> | null = null;
  let flushing = false;

  async function flushRoute(routeId: string): Promise<void> {
    const rows = await options.ops.takeBridgeBuffer(routeId);
    if (rows.length === 0) return;

    const envelopes = rows
      .map((row) => safeParseEnvelope(row.envelopeJson))
      .filter((envelope): envelope is BridgeEnvelope => envelope !== null);

    if (envelopes.length === 0) {
      logger.error(
        { routeId, rows: rows.length },
        'Bridge summary buffer: all buffered rows failed envelope validation, dropping',
      );
      return;
    }

    const targetChatId = options.targetChatIdForRoute(routeId);
    const targetPlatform = options.targetPlatformForRoute(routeId);
    if (!targetChatId || !targetPlatform) {
      await options.ops.restoreBridgeBuffer(rows);
      logger.error(
        { routeId },
        'Bridge summary buffer: unresolved route target, restored buffered rows',
      );
      return;
    }

    const [firstEnvelope] = envelopes;
    const header = `${platformLabel(firstEnvelope.origin.platform)} — last ${intervalMinutes} min:`;
    const lines = envelopes.map((envelope) => envelopeLine(envelope, targetPlatform));
    const text = buildDigestText(header, lines, maxText);

    try {
      await options.sendText(targetChatId, text);
      consecutiveFailures.set(routeId, 0);
    } catch (err) {
      await options.ops.restoreBridgeBuffer(rows);

      if (err instanceof WhatsAppOutboundHeldError) return;

      const failures = (consecutiveFailures.get(routeId) ?? 0) + 1;
      consecutiveFailures.set(routeId, failures);
      logger.error(
        { routeId, consecutiveFailures: failures },
        'Bridge summary buffer: send failed, restored buffered rows',
      );

      if (failures >= EARLIER_MESSAGES_LOUD_THRESHOLD) {
        const depths = await options.ops.bridgeBufferDepths();
        logger.error(
          { routeId, consecutiveFailures: failures, depth: depths[routeId] ?? rows.length },
          'Bridge summary buffer: route failing repeatedly, buffer keeps growing',
        );
      }
    }
  }

  async function flushTick(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      const depths = await options.ops.bridgeBufferDepths();
      for (const routeId of Object.keys(depths)) {
        if ((depths[routeId] ?? 0) > 0) await flushRoute(routeId);
      }
    } catch (err) {
      logger.error({ err }, 'Bridge summary buffer: flush tick failed');
    } finally {
      flushing = false;
    }
  }

  return {
    async bufferEnvelope(envelope: BridgeEnvelope): Promise<void> {
      await options.ops.appendBridgeBuffer(envelope.routeId, JSON.stringify(envelope));
    },

    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        void flushTick();
      }, intervalMinutes * MINUTE_MS);
      timer.unref?.();
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    async depths(): Promise<Record<string, number>> {
      return options.ops.bridgeBufferDepths();
    },
  };
}
