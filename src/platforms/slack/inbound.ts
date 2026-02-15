import type { InboundMessage } from '../../core/inbound-message.js';
import type { MessageRef } from '../../core/message-ref.js';

/**
 * Slack inbound message (normalized).
 *
 * Slack support is not implemented yet; this type is a placeholder to help
 * build platform-agnostic core logic without committing to a specific Slack SDK.
 */
export interface SlackInbound extends InboundMessage {
  platform: 'slack';
  raw: MessageRef;
}
