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

async function buildAudioOnlyRelayBody(inbound: InboundMessage): Promise<RelayBody> {
  if (!process.env.WHISPER_URL || !inbound.audio) return { text: '[voice note]', kind: 'media-placeholder' };

  try {
    const response = await fetch(inbound.audio.url);
    if (!response.ok) return { text: '[voice note]', kind: 'media-placeholder' };

    const { transcribeAudio } = await import('../features/voice.js');
    const audioBuffer = Buffer.from(await response.arrayBuffer());
    const transcript = await transcribeAudio(audioBuffer, inbound.audio.contentType);
    const cleanTranscript = transcript?.trim();
    if (!cleanTranscript) return { text: '[voice note]', kind: 'media-placeholder' };

    return { text: `🎤 ${cleanTranscript}`, kind: 'message' };
  } catch {
    return { text: '[voice note]', kind: 'media-placeholder' };
  }
}

function buildEnvelope(params: {
  inbound: InboundMessage;
  instanceId: string;
  messageId: string;
  route: BridgeRoute;
  target: { instance: string; chatId: string };
  body: RelayBody;
}): BridgeEnvelope {
  return {
    v: 1,
    routeId: params.route.id,
    origin: {
      instance: params.instanceId,
      platform: params.inbound.platform,
      chatId: params.inbound.chatId,
      chatName: params.inbound.chatName?.trim() ? params.inbound.chatName : undefined,
      messageId: params.messageId,
      senderId: params.inbound.senderId,
      senderName: params.inbound.senderName?.trim() ? params.inbound.senderName : undefined,
    },
    targetInstance: params.target.instance,
    targetChatId: params.target.chatId,
    text: params.body.text,
    kind: params.body.kind,
    sentAtMs: Date.now(),
    idempotencyKey: buildIdempotencyKey({
      instance: params.instanceId,
      chatId: params.inbound.chatId,
      messageId: params.messageId,
    }),
  };
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
      const messageId = inbound.messageId;

      const target = otherEndpoint(route, instanceId);
      if (!target) return;

      if (inbound.audio && !inbound.text && process.env.WHISPER_URL) {
        void (async () => {
          const body = await buildAudioOnlyRelayBody(inbound);
          const envelope = buildEnvelope({ inbound, instanceId, messageId, route, target, body });
          await enqueue(envelope);
        })().catch((err) => {
          logger.error({ err, routeId: route.id }, 'Bridge capture: enqueue failed');
        });
        return;
      }

      const body = buildRelayBody(inbound);
      if (!body) return;

      const envelope = buildEnvelope({ inbound, instanceId, messageId, route, target, body });

      void enqueue(envelope).catch((err) => {
        logger.error({ err, routeId: route.id }, 'Bridge capture: enqueue failed');
      });
    },
  };
}
