import { logger } from '../middleware/logger.js';
import type { InboundMessage } from '../core/inbound-message.js';
import { findOutboundRoute, type BridgeMap, type BridgeRoute } from './bridge-map.js';
import { buildIdempotencyKey, type BridgeEnvelope, type BridgeMedia } from './envelope.js';
import { getBridgeMediaMaxBytes, isBridgeMediaEnabled } from '../utils/config/bridge.js';
import { captureInboundMedia, fetchBridgeMedia } from './media-capture.js';

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

const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20MB

// The discord CDN url can carry signed query params — log the host only,
// never the full url (and never the transcript/text).
function urlHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function cleanChatName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// Each instance appears at most once per route (enforced by BridgeMapSchema),
// so excluding the origin by instance excludes exactly the sending endpoint.
function otherEndpoints(
  route: BridgeRoute,
  instanceId: string,
): { instance: string; chatId: string }[] {
  return route.endpoints.filter((endpoint) => endpoint.instance !== instanceId);
}

function buildRelayBody(inbound: InboundMessage): RelayBody | null {
  if (inbound.platform === 'whatsapp' && inbound.audio) {
    if (!inbound.text || inbound.synthesizedPlaceholder) {
      return { text: '[voice note]', kind: 'media-placeholder' };
    }
    return { text: inbound.text, kind: 'message' };
  }
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

async function buildAudioOnlyRelayBody(
  inbound: InboundMessage,
  maxBytes: number,
): Promise<{ body: RelayBody; buffer: Buffer | null }> {
  if (!process.env.WHISPER_URL || !inbound.audio) {
    return { body: { text: '[voice note]', kind: 'media-placeholder' }, buffer: null };
  }

  const audioBuffer = inbound.audio.buffer ?? await fetchBridgeMedia(inbound.audio.url, maxBytes);
  if (!audioBuffer) {
    return { body: { text: '[voice note]', kind: 'media-placeholder' }, buffer: null };
  }

  try {
    const { transcribeAudio } = await import('../features/voice.js');
    const transcript = await transcribeAudio(audioBuffer, inbound.audio.contentType);
    const cleanTranscript = transcript?.trim();
    if (!cleanTranscript) {
      return { body: { text: '[voice note]', kind: 'media-placeholder' }, buffer: audioBuffer };
    }

    return { body: { text: `🎤 ${cleanTranscript}`, kind: 'message' }, buffer: audioBuffer };
  } catch (err) {
    logger.warn({ host: urlHost(inbound.audio.url), err }, 'Bridge capture: audio transcription failed');
    return { body: { text: '[voice note]', kind: 'media-placeholder' }, buffer: audioBuffer };
  }
}

function buildEnvelope(params: {
  inbound: InboundMessage;
  instanceId: string;
  messageId: string;
  route: BridgeRoute;
  target: { instance: string; chatId: string };
  body: RelayBody;
  media?: BridgeMedia;
}): BridgeEnvelope {
  const envelope = {
    routeId: params.route.id,
    origin: {
      instance: params.instanceId,
      platform: params.inbound.platform,
      chatId: params.inbound.chatId,
      chatName: cleanChatName(params.inbound.chatName),
      messageId: params.messageId,
      senderId: params.inbound.senderId,
      senderName: params.inbound.senderName?.trim() ? params.inbound.senderName : undefined,
    },
    targetInstance: params.target.instance,
    targetChatId: params.target.chatId,
    text: params.body.text,
    kind: params.body.kind,
    sentAtMs: Date.now(),
    idempotencyKey: buildIdempotencyKey(
      {
        instance: params.instanceId,
        chatId: params.inbound.chatId,
        messageId: params.messageId,
      },
      params.target,
    ),
  };
  return params.media
    ? { v: 2, ...envelope, media: params.media }
    : { v: 1, ...envelope };
}

export function createRelayCapture({ instanceId, bridgeMap, enqueue }: RelayCaptureOptions): RelayCapture {
  return {
    capture(inbound: InboundMessage): void {
      const route = findOutboundRoute(bridgeMap, instanceId, inbound.chatId);
      if (!route) return;

      if (!inbound.text && !inbound.audio && !inbound.media && !inbound.hasVisualMedia) return;
      if (inbound.text?.startsWith('!') && !route.relayCommands) return;

      if (!inbound.messageId) {
        logger.debug({ routeId: route.id, chatId: inbound.chatId }, 'Bridge capture: skipping message without a messageId');
        return;
      }
      const messageId = inbound.messageId;

      const targets = otherEndpoints(route, instanceId);
      if (targets.length === 0) return;

      const enqueueAll = (body: RelayBody, media?: BridgeMedia): Promise<void> => Promise.all(
        targets.map((target) => enqueue(buildEnvelope({
          inbound,
          instanceId,
          messageId,
          route,
          target,
          body,
          ...(media ? { media } : {}),
        }))),
      ).then(() => undefined);

      const mediaRelayEnabled = isBridgeMediaEnabled() && route.mediaRelay;
      if (mediaRelayEnabled && (inbound.audio || inbound.media)) {
        void (async () => {
          let body = buildRelayBody(inbound);
          let audioBuffer: Buffer | null | undefined;
          if (inbound.audio && !inbound.text && process.env.WHISPER_URL) {
            const resolved = await buildAudioOnlyRelayBody(inbound, getBridgeMediaMaxBytes());
            body = resolved.body;
            audioBuffer = resolved.buffer;
          }
          if (!body) return;

          let media: BridgeMedia | null = null;
          try {
            media = await captureInboundMedia(inbound, getBridgeMediaMaxBytes(), route.id, audioBuffer);
          } catch (err) {
            logger.warn({ err, routeId: route.id }, 'Bridge capture: media preparation failed');
          }
          await enqueueAll(body, media ?? undefined);
        })().catch((err) => {
          logger.error({ err, routeId: route.id }, 'Bridge capture: enqueue failed');
        });
        return;
      }

      if (inbound.audio && !inbound.text && process.env.WHISPER_URL) {
        void (async () => {
          const { body } = await buildAudioOnlyRelayBody(inbound, MAX_AUDIO_BYTES);
          await enqueueAll(body);
        })().catch((err) => {
          logger.error({ err, routeId: route.id }, 'Bridge capture: enqueue failed');
        });
        return;
      }

      const body = buildRelayBody(inbound);
      if (!body) return;

      for (const target of targets) {
        const envelope = buildEnvelope({ inbound, instanceId, messageId, route, target, body });
        void enqueue(envelope).catch((err) => {
          logger.error({ err, routeId: route.id }, 'Bridge capture: enqueue failed');
        });
      }
    },
  };
}
