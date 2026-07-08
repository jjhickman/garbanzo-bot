import { logger } from '../middleware/logger.js';
import { recordMessage } from '../middleware/context.js';
import { recordBridgeSeenDedupHit } from '../middleware/stats.js';
import { config } from '../utils/config.js';
import type { InboundMessage } from '../core/inbound-message.js';
import type { MessagingPlatform } from '../core/messaging-platform.js';
import type { PlatformMessenger } from '../core/platform-messenger.js';
import {
  appendBridgeBuffer,
  bridgeBufferDepths,
  bridgeOutboxCounts,
  bridgeSeenDelete as bridgeSeenDeleteDefault,
  bridgeSeenInsert as bridgeSeenInsertDefault,
  bumpBridgeOutboxAttempt,
  claimDueBridgeOutbox,
  deferBridgeOutbox,
  enqueueBridgeOutbox,
  markBridgeOutboxDead,
  markBridgeOutboxSent,
  restoreBridgeBuffer,
  takeBridgeBuffer,
} from '../utils/db.js';
import { loadBridgeMap as loadBridgeMapDefault, type BridgeMap, type BridgeRoute } from './bridge-map.js';
import type { BridgeEnvelope } from './envelope.js';
import { createBridgeOutbox, type BridgeOutboxOps } from './outbox.js';
import { createRelayCapture } from './relay-capture.js';
import { attributionPrefix, createRelayDeliverer } from './relay-deliver.js';
import { createSummaryBuffer, type BridgeBufferOps } from './summary-buffer.js';
import { createAmqpBridgeTransport } from './transport-amqp.js';
import { createHttpBridgeTransport } from './transport-http.js';
import type { BridgeTransport, InboundBridgeResult } from './transport.js';

export type BridgeInboundHandler = (envelope: BridgeEnvelope) => Promise<InboundBridgeResult>;

export interface StartBridgeDeps {
  /** Current outbound messenger, when the platform runtime is connected (may be null while reconnecting). */
  getMessenger(): PlatformMessenger | null;
  loadBridgeMap?(): BridgeMap | null;
  bridgeSeenInsert?(key: string): Promise<boolean>;
  bridgeSeenDelete?(key: string): Promise<boolean>;
  outboxOps?: BridgeOutboxOps;
  bufferOps?: BridgeBufferOps;
  transport?: BridgeTransport;
}

export interface BridgeLifecycle {
  handler: BridgeInboundHandler;
  stop(): Promise<void>;
}

// Set while a bridge is running so platform processors (which never import
// this module's assembly directly) can pick up the fire-and-forget capture
// hook without core (`process-inbound-message.ts`) knowing anything about
// bridges. Cleared on stop().
let activeCapture: ((inbound: InboundMessage) => void) | null = null;

export function getCaptureForBridge(): ((inbound: InboundMessage) => void) | null {
  return activeCapture;
}

/**
 * Resolve delivery mode per DESTINATION platform explicitly, rather than a
 * binary whatsapp-else-discord check (fixed per review — the old else branch
 * silently handed Telegram destinations Discord's per-route modeToDiscord
 * setting, which was never meant to configure Telegram). WhatsApp gets the
 * bridge-map-configurable modeToWhatsApp because the summary buffer exists
 * to fold messages behind WhatsApp's outbound-safety backpressure
 * (WhatsAppOutboundHeldError) — no other platform's messenger throws that.
 * Discord keeps its own configurable modeToDiscord. Telegram (and any future
 * platform with no dedicated bridge-map field) always relays directly:
 * there is nothing to buffer against, and Telegram's own 429 handling is
 * internalized in the adapter's send path (see relay-deliver.ts).
 */
function modeForPlatform(route: BridgeRoute, platform: MessagingPlatform): 'summary' | 'verbatim' {
  if (platform === 'whatsapp') return route.modeToWhatsApp;
  if (platform === 'discord') return route.modeToDiscord;
  return 'verbatim';
}

/**
 * Assemble and start the cross-instance bridge for this process, or return
 * null when the single gate (`BRIDGE_ENABLED`) is off, or when the bridge map
 * cannot be loaded. Flags-off must be inert: nothing below the gate check
 * runs, and none of `deps` is ever called.
 */
export async function startBridge(deps: StartBridgeDeps): Promise<BridgeLifecycle | null> {
  if (!config.BRIDGE_ENABLED) return null;

  const loadMap = deps.loadBridgeMap ?? loadBridgeMapDefault;
  const loadedMap = loadMap();
  if (!loadedMap) {
    logger.warn('Bridge enabled but bridge map failed to load — bridge inert');
    return null;
  }
  // Re-bind to a definitely-non-null const: nested function declarations
  // below close over this, and TS does not carry the `if (!loadedMap)`
  // narrowing into them.
  const map: BridgeMap = loadedMap;

  const instanceId = config.INSTANCE_ID ?? config.MESSAGING_PLATFORM;
  const platform = config.MESSAGING_PLATFORM;

  const bridgeSeenInsert = deps.bridgeSeenInsert ?? bridgeSeenInsertDefault;
  const bridgeSeenDelete = deps.bridgeSeenDelete ?? bridgeSeenDeleteDefault;

  const outboxOps: BridgeOutboxOps = deps.outboxOps ?? {
    enqueueBridgeOutbox,
    claimDueBridgeOutbox,
    markBridgeOutboxSent,
    markBridgeOutboxDead,
    bumpBridgeOutboxAttempt,
    deferBridgeOutbox,
    bridgeOutboxCounts,
  };
  const bufferOps: BridgeBufferOps = deps.bufferOps ?? {
    appendBridgeBuffer,
    takeBridgeBuffer,
    restoreBridgeBuffer,
    bridgeBufferDepths,
  };

  const urlByInstance = new Map(map.instances.map((instance) => [instance.id, instance.url ?? null] as const));
  const resolveTargetUrl = (targetInstanceId: string): string | null => urlByInstance.get(targetInstanceId) ?? null;

  const transport: BridgeTransport = deps.transport ?? (config.BRIDGE_TRANSPORT === 'amqp'
    ? createAmqpBridgeTransport({ instanceId })
    : createHttpBridgeTransport());

  // The messenger only exists once the platform runtime has connected, and it
  // is re-created across WhatsApp reconnects, so the bridge holds a lazy
  // accessor rather than a snapshot taken at assembly time.
  const lazyMessenger: Pick<PlatformMessenger, 'sendText'> = {
    async sendText(chatId: string, text: string): Promise<void> {
      const messenger = deps.getMessenger();
      if (!messenger) throw new Error('Bridge: platform messenger is not connected yet');
      await messenger.sendText(chatId, text);
    },
  };

  function routeById(routeId: string): BridgeRoute | undefined {
    return map.routes.find((route) => route.id === routeId);
  }

  function ourChatIdForRoute(routeId: string): string | null {
    const route = routeById(routeId);
    return route?.endpoints.find((endpoint) => endpoint.instance === instanceId)?.chatId ?? null;
  }

  const summaryBuffer = createSummaryBuffer({
    sendText: (chatId, text) => lazyMessenger.sendText(chatId, text),
    targetChatIdForRoute: ourChatIdForRoute,
    targetPlatformForRoute: () => platform,
    ops: bufferOps,
  });

  const deliverer = createRelayDeliverer({
    messenger: lazyMessenger,
    platform,
    bufferEnvelope: summaryBuffer.bufferEnvelope,
  });

  const outbox = createBridgeOutbox({ transport, resolveTargetUrl, ops: outboxOps });

  const capture = createRelayCapture({
    instanceId,
    bridgeMap: map,
    enqueue: (envelope) => outbox.enqueue(envelope),
  });
  activeCapture = capture.capture;

  // REQUIRED FIX (T6 review): the dedup key is inserted BEFORE delivery is
  // attempted. If delivery then THROWS (a non-held failure — 'buffered' is
  // success), the key must be removed before rethrowing so the endpoint 503s
  // and the sender's retry of the SAME envelope is treated as fresh instead
  // of silently dropped as a duplicate.
  const handler: BridgeInboundHandler = async (envelope) => {
    const fresh = await bridgeSeenInsert(envelope.idempotencyKey);
    if (!fresh) {
      recordBridgeSeenDedupHit(envelope.routeId);
      return 'duplicate';
    }

    try {
      const route = routeById(envelope.routeId);
      const mode = route ? modeForPlatform(route, platform) : 'verbatim';
      if (mode === 'summary') {
        await summaryBuffer.bufferEnvelope(envelope);
      } else {
        const status = await deliverer.deliver(envelope);
        if (status === 'sent' && route?.ingestRelayed) {
          // Shared with the delivered relay text (relay-deliver.ts) so the
          // context stored here always matches what the receiving side saw —
          // in particular so chatName isn't dropped on one side only.
          const prefix = attributionPrefix(envelope.origin);
          await recordMessage(
            envelope.targetChatId,
            envelope.origin.senderId,
            `${prefix}${envelope.text}`,
          ).catch((err) => {
            logger.error({ err, routeId: envelope.routeId }, 'Bridge: relayed-content context ingest failed');
          });
        }
      }
      return 'accepted';
    } catch (err) {
      await bridgeSeenDelete(envelope.idempotencyKey);
      throw err;
    }
  };

  await transport.startInbound(handler);
  summaryBuffer.start();
  outbox.start();

  return {
    handler,
    async stop(): Promise<void> {
      activeCapture = null;
      summaryBuffer.stop();
      await outbox.stop(); // also stops the transport (cancels amqp consumer / closes connection)
    },
  };
}
