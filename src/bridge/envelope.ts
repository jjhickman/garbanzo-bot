import { z } from 'zod';
import { getBridgeMediaMaxBytes } from '../utils/config/bridge.js';

export { BRIDGE_MEDIA_MAX_BYTES_DEFAULT } from '../utils/config/bridge.js';

// Mirrors MessagingPlatform (src/core/messaging-platform.ts). Defined locally rather
// than imported so the wire schema stays independent of internal config plumbing.
export const MessagingPlatformSchema = z.enum(['whatsapp', 'discord', 'slack', 'telegram', 'matrix']);

export const BridgeOriginSchema = z
  .object({
    instance: z.string().min(1),
    platform: MessagingPlatformSchema,
    chatId: z.string().min(1),
    chatName: z.string().min(1).optional(),
    messageId: z.string().min(1),
    senderId: z.string().min(1),
    senderName: z.string().min(1).optional(),
  })
  .strict();

export const BRIDGE_MEDIA_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'application/pdf',
] as const;

const BRIDGE_MEDIA_BASE64_LENGTH_SLACK = 16;

export function bridgeMediaBase64MaxLength(maxBytes: number): number {
  return Math.ceil(maxBytes / 3) * 4 + BRIDGE_MEDIA_BASE64_LENGTH_SLACK;
}

export const BridgeMediaSchema = z.object({
  data: z.base64().min(1).refine(
    (data) => data.length <= bridgeMediaBase64MaxLength(getBridgeMediaMaxBytes()),
    { message: 'Bridge media data exceeds BRIDGE_MEDIA_MAX_BYTES' },
  ),
  mimetype: z.enum(BRIDGE_MEDIA_MIME_TYPES),
  fileName: z.string(),
  kind: z.enum(['image', 'video', 'audio', 'sticker', 'document']),
  ptt: z.boolean().optional(),
}).strict();

const BridgeEnvelopeShape = {
  routeId: z.string().min(1),
  origin: BridgeOriginSchema,
  targetInstance: z.string().min(1),
  targetChatId: z.string().min(1),
  text: z.string(),
  kind: z.enum(['message', 'media-placeholder']),
  sentAtMs: z.number().int().positive(),
  /**
   * Dedup key scoped to one origin message and one fan-out target. Produced
   * by {@link buildIdempotencyKey} as a JSON-array encoding of
   * `[origin.instance, origin.chatId, origin.messageId, target.instance,
   * target.chatId]`, which is injective even when any field contains ':'
   * (e.g. a Matrix room/event id).
   */
  idempotencyKey: z.string().min(1),
};

export const BridgeEnvelopeV1Schema = z.object({
  v: z.literal(1),
  ...BridgeEnvelopeShape,
}).strict();

export const BridgeEnvelopeV2Schema = z.object({
  v: z.literal(2),
  ...BridgeEnvelopeShape,
  media: BridgeMediaSchema.optional(),
}).strict();

export const BridgeEnvelopeSchema = z.discriminatedUnion('v', [
  BridgeEnvelopeV1Schema,
  BridgeEnvelopeV2Schema,
]);

export type BridgeOrigin = z.infer<typeof BridgeOriginSchema>;
export type BridgeMedia = z.infer<typeof BridgeMediaSchema>;
export type BridgeEnvelopeV1 = z.infer<typeof BridgeEnvelopeV1Schema>;
export type BridgeEnvelopeV2 = z.infer<typeof BridgeEnvelopeV2Schema>;
export type BridgeEnvelope = z.infer<typeof BridgeEnvelopeSchema>;

export function envelopeSupportsMedia(envelope: BridgeEnvelope): envelope is BridgeEnvelopeV2 {
  return envelope.v === 2;
}

/**
 * Target-scoped dedup key. A single origin message can fan out to multiple
 * bridge targets, and each leg must survive receiver-side bridge_seen dedup.
 *
 * The fields are JSON-array encoded rather than joined with a separator: a
 * plain `:` join is not injective because instance/chat/message ids accept
 * arbitrary strings (Matrix room/event ids literally contain ':'), so two
 * distinct origin/target tuples could collide and the receiver's INSERT OR
 * IGNORE dedup would silently drop a real leg. JSON.stringify escapes the
 * field boundaries, so the mapping from tuple to key is one-to-one. The key
 * is a pure function of the tuple, so retrying the same leg reproduces the
 * identical key (exactly-once delivery is preserved).
 */
export function buildIdempotencyKey(
  origin: Pick<BridgeOrigin, 'instance' | 'chatId' | 'messageId'>,
  target: { instance: string; chatId: string },
): string {
  return JSON.stringify([
    origin.instance,
    origin.chatId,
    origin.messageId,
    target.instance,
    target.chatId,
  ]);
}

export function parseBridgeEnvelope(raw: unknown): BridgeEnvelope | null {
  const parsed = BridgeEnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
