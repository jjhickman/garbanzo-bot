import { z } from 'zod';
import { coreSchema } from '../utils/config/core.js';

export const MessagingPlatformSchema = coreSchema.shape.MESSAGING_PLATFORM.removeDefault();

export const BridgeOriginSchema = z.object({
  instance: z.string().min(1),
  platform: MessagingPlatformSchema,
  chatId: z.string().min(1),
  messageId: z.string().min(1),
  senderId: z.string().min(1),
  senderName: z.string().min(1).optional(),
});

export const BridgeEnvelopeSchema = z.object({
  v: z.literal(1),
  routeId: z.string().min(1),
  origin: BridgeOriginSchema,
  targetInstance: z.string().min(1),
  targetChatId: z.string().min(1),
  text: z.string(),
  kind: z.enum(['message', 'media-placeholder']),
  sentAtMs: z.number().int().positive(),
  idempotencyKey: z.string().min(1),
});

export type BridgeOrigin = z.infer<typeof BridgeOriginSchema>;
export type BridgeEnvelope = z.infer<typeof BridgeEnvelopeSchema>;

export function buildIdempotencyKey(
  origin: Pick<BridgeOrigin, 'instance' | 'chatId' | 'messageId'>,
): string {
  return `${origin.instance}:${origin.chatId}:${origin.messageId}`;
}

export function parseBridgeEnvelope(raw: unknown): BridgeEnvelope | null {
  const parsed = BridgeEnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
