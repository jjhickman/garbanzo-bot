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

  /**
   * Replied-to message's id, when this message is a reply. The replied-to
   * message's attachments are NOT threaded inline (discord.js exposes only
   * the reference id) — they are fetched lazily via REST
   * (`DiscordMessenger.fetchMessageAttachments`), strictly after the
   * engagement decision and only when the engaging message has no
   * attachment of its own.
   */
  referencedMessageId?: string;
}
