import type { InboundMessage } from '../../core/inbound-message.js';
import type { MessageRef } from '../../core/message-ref.js';

/**
 * Telegram inbound message (normalized).
 *
 * Used by the Telegram long-poll runtime (client.ts -> processor.ts).
 */
export interface TelegramInbound extends InboundMessage {
  platform: 'telegram';
  raw: MessageRef;
}
