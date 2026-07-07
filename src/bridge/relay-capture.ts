import { logger } from '../middleware/logger.js';
import type { InboundMessage } from '../core/inbound-message.js';
import { findOutboundRoute, type BridgeMap, type BridgeRoute } from './bridge-map.js';
import { buildIdempotencyKey, type BridgeEnvelope } from './envelope.js';

export interface RelayCaptureOptions {
  instanceId: string;
  bridgeMap: BridgeMap;
  /** Durable outbox enqueue — capture() fires this and forgets it. */
  enqueue(envelope: BridgeEnvelope): Promise<void>;
}

export interface RelayCapture {
  /**
   * Synchronous, fire-and-forget: never throws and never awaits the enqueue
   * promise, so it can sit directly in the reply path without adding latency
   * or failure modes to it.
   */
  capture(inbound: InboundMessage): void;
}

interface RelayBody {
  text: string;
  kind: BridgeEnvelope['kind'];
}

function otherEndpoint(route: BridgeRoute, instanceId: string): { instance: string; chatId: string } | undefined {
  return route.endpoints.find((endpoint) => endpoint.instance !== instanceId);
}

function buildRelayBody(inbound: InboundMessage): RelayBody | null {
  if (inbound.audio || inbound.hasVisualMedia) {
    const placeholder = inbound.audio ? '[voice note]' : '[image]';
    const caption = inbound.text?.trim();
    return { text: caption ? `${placeholder} ${caption}` : placeholder, kind: 'media-placeholder' };
  }

  if (inbound.text) {
    return { text: inbound.text, kind: 'message' };
  }

  return null;
}

export function createRelayCapture({ instanceId, bridgeMap, enqueue }: RelayCaptureOptions): RelayCapture {
  return {
    capture(inbound: InboundMessage): void {
      const route = findOutboundRoute(bridgeMap, instanceId, inbound.chatId);
      if (!route) return;

      if (!inbound.text && !inbound.audio && !inbound.hasVisualMedia) return;
      if (inbound.text?.startsWith('!') && !route.relayCommands) return;

      if (!inbound.messageId) {
        logger.debug({ routeId: route.id, chatId: inbound.chatId }, 'Bridge capture: skipping message without a messageId');
        return;
      }

      const target = otherEndpoint(route, instanceId);
      if (!target) return;

      const body = buildRelayBody(inbound);
      if (!body) return;

      const envelope: BridgeEnvelope = {
        v: 1,
        routeId: route.id,
        origin: {
          instance: instanceId,
          platform: inbound.platform,
          chatId: inbound.chatId,
          messageId: inbound.messageId,
          senderId: inbound.senderId,
          senderName: inbound.senderName?.trim() ? inbound.senderName : undefined,
        },
        targetInstance: target.instance,
        targetChatId: target.chatId,
        text: body.text,
        kind: body.kind,
        sentAtMs: Date.now(),
        idempotencyKey: buildIdempotencyKey({
          instance: instanceId,
          chatId: inbound.chatId,
          messageId: inbound.messageId,
        }),
      };

      void enqueue(envelope).catch((err) => {
        logger.error({ err, routeId: route.id }, 'Bridge capture: enqueue failed');
      });
    },
  };
}
