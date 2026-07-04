import type { MessagingPlatform } from './messaging-platform.js';
import type { MessageRef } from './message-ref.js';

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

  /**
   * When this message is an edit of an earlier message, the original
   * message's id. Edits re-run moderation and intro classification against
   * the new content but never trigger replies/acknowledgments.
   */
  editOfMessageId?: string;

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

  /** Roles the sender holds, where the platform exposes them. */
  senderRoleIds?: string[];

  /** True if the message includes visual media. */
  hasVisualMedia: boolean;

  /**
   * An audio attachment on the message, where the platform surfaces it
   * (Discord); undefined otherwise.
   */
  audio?: { url: string; contentType: string };

  /** Platform-specific raw message for advanced operations. */
  raw: MessageRef;
}
