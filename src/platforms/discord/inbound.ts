import type { InboundMessage } from '../../core/inbound-message.js';
import type { MessageRef } from '../../core/message-ref.js';

/**
 * Discord inbound message (normalized).
 *
 * Discord production runtime is not implemented yet; this type exists for
 * local demo-mode pipeline validation.
 */
export interface DiscordInbound extends InboundMessage {
  platform: 'discord';
  raw: MessageRef;
}
