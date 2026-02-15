import type { MessagingPlatform } from '../platforms/types.js';

/**
 * Normalized inbound message.
 *
 * Platform adapters should map their native message types into this shape.
 * For now, WhatsApp uses this type but still carries the raw native message
 * for features that need platform-specific operations (media download, quoting).
 */
export interface InboundMessage {
  platform: MessagingPlatform;
  chatId: string;
  senderId: string;

  /** Platform message id, when available. */
  messageId?: string;

  /** True when the message was sent by the bot itself. */
  fromSelf: boolean;

  /** Status/broadcast messages should be ignored. */
  isStatusBroadcast: boolean;

  /** True when this chat is a group chat on the platform. */
  isGroupChat: boolean;

  /** Milliseconds since epoch. */
  timestampMs: number;

  /** Text content if present (after unwrapping platform wrappers). */
  text: string | null;

  /** Quoted/replied-to text if present. */
  quotedText?: string;

  /** Platform-native mention identifiers, when available. */
  mentionedIds?: string[];

  /** True if the message includes visual media. */
  hasVisualMedia: boolean;

  /** Platform-specific raw message for advanced operations. */
  raw: unknown;
}
