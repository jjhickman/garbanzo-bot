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

// Mirrors fetchAndTranscribe's bound (src/features/song-ideas.ts): the
// timeout must cover the WHOLE download (request + body read), not just the
// initial response, since a hung body read is just as dangerous as a hung
// connection. Bridge audio additionally comes from arbitrary CDN urls the
// bot doesn't control (vs. the first-party attachment flow song-ideas
// serves), so this also caps the response size — via Content-Length when
// the server sends one, and by aborting the in-flight read once the
// buffered bytes exceed the cap when it doesn't — so a single oversized or
// slow-drip clip can't balloon memory or hang the capture path.
const AUDIO_FETCH_TIMEOUT_MS = 15_000;
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

async function readBoundedBody(
  response: Response,
  controller: AbortController,
  maxBytes: number,
): Promise<Buffer | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength > maxBytes ? null : buffer;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

/**
 * Fetch bridge audio with a bound on both time and size. Returns null on ANY
 * bound violation or failure (bad status, size cap, network error, timeout);
 * the caller falls back to the voice-note placeholder — never throws.
 */
async function fetchAudioBuffer(url: string): Promise<Buffer | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUDIO_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      logger.warn({ host: urlHost(url), status: response.status }, 'Bridge capture: audio fetch failed');
      return null;
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_AUDIO_BYTES) {
      logger.warn({ host: urlHost(url), contentLength }, 'Bridge capture: audio exceeds size cap');
      return null;
    }

    const buffer = await readBoundedBody(response, controller, MAX_AUDIO_BYTES);
    if (!buffer) {
      logger.warn({ host: urlHost(url) }, 'Bridge capture: audio body exceeded size cap while downloading');
      return null;
    }
    return buffer;
  } catch (err) {
    logger.warn({ host: urlHost(url), err }, 'Bridge capture: audio fetch/read failed');
    return null;
  } finally {
    clearTimeout(timeout);
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

  const audioBuffer = await fetchAudioBuffer(inbound.audio.url);
  if (!audioBuffer) return { text: '[voice note]', kind: 'media-placeholder' };

  try {
    const { transcribeAudio } = await import('../features/voice.js');
    const transcript = await transcribeAudio(audioBuffer, inbound.audio.contentType);
    const cleanTranscript = transcript?.trim();
    if (!cleanTranscript) return { text: '[voice note]', kind: 'media-placeholder' };

    return { text: `🎤 ${cleanTranscript}`, kind: 'message' };
  } catch (err) {
    logger.warn({ host: urlHost(inbound.audio.url), err }, 'Bridge capture: audio transcription failed');
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

      const targets = otherEndpoints(route, instanceId);
      if (targets.length === 0) return;

      if (inbound.audio && !inbound.text && process.env.WHISPER_URL) {
        void (async () => {
          const body = await buildAudioOnlyRelayBody(inbound);
          await Promise.all(targets.map((target) =>
            enqueue(buildEnvelope({ inbound, instanceId, messageId, route, target, body })),
          ));
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
