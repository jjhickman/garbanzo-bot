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
    /** Dedup key scoped to one origin message and one fan-out target. */
    idempotencyKey: z.string().min(1),
  })
  .strict();

export type BridgeOrigin = z.infer<typeof BridgeOriginSchema>;
export type BridgeEnvelope = z.infer<typeof BridgeEnvelopeSchema>;

/**
 * Target-scoped dedup key. A single origin message can fan out to multiple
 * bridge targets, and each leg must survive receiver-side bridge_seen dedup.
 */
export function buildIdempotencyKey(
  origin: Pick<BridgeOrigin, 'instance' | 'chatId' | 'messageId'>,
  target: { instance: string; chatId: string },
): string {
  return `${origin.instance}:${origin.chatId}:${origin.messageId}:${target.instance}:${target.chatId}`;
}

export function parseBridgeEnvelope(raw: unknown): BridgeEnvelope | null {
  const parsed = BridgeEnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
