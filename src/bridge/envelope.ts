import { z } from 'zod';

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

export const BridgeEnvelopeSchema = z
  .object({
    v: z.literal(1),
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
  })
  .strict();

export type BridgeOrigin = z.infer<typeof BridgeOriginSchema>;
export type BridgeEnvelope = z.infer<typeof BridgeEnvelopeSchema>;

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
