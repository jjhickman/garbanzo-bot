import type { InboundMessage } from '../../core/inbound-message.js';
import type { MessageRef } from '../../core/message-ref.js';

/**
 * Slack inbound message (normalized).
 *
 * Used by official Slack Events API runtime and demo runtime.
 */
export interface SlackInbound extends InboundMessage {
  platform: 'slack';
  raw: MessageRef;
}
