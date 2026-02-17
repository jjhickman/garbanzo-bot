import type { InboundMessage } from '../../core/inbound-message.js';
import type { MessageRef } from '../../core/message-ref.js';

/**
 * Discord inbound message (normalized).
 *
 * Used by official Discord interactions runtime and demo runtime.
 */
export interface DiscordInbound extends InboundMessage {
  platform: 'discord';
  raw: MessageRef;
}
