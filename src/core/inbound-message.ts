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

  /** Human-readable sender display name, when the platform provides one. */
  senderName?: string;

  /** Human-readable chat/channel display name, when configured. */
  chatName?: string;

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
   * (Discord, Telegram); undefined otherwise.
   *
   * `buffer` is Telegram-only: Telegram file URLs embed the bot token
   * (`api.telegram.org/file/bot<TOKEN>/...`), so the Telegram adapter never
   * puts that URL here — `url` is a safe, non-fetchable placeholder
   * (`telegram-file:<file_id>`) and `buffer` carries the already-downloaded
   * bytes for consumers that need the audio content. See
   * `src/platforms/telegram/telegram-voice.ts`.
   */
  audio?: { url: string; contentType: string; buffer?: Buffer; ptt?: boolean };

  /** First non-audio attachment available for optional bridge re-upload. */
  media?: {
    url?: string;
    contentType: string;
    fileName?: string;
    buffer?: Buffer;
    kind: 'image' | 'video' | 'audio' | 'sticker' | 'document';
    ptt?: boolean;
  };

  /**
   * Replied-to message's audio attachment, where the platform threads it
   * (Telegram — same URL-safety rules as `audio`: Telegram uses the
   * non-fetchable `telegram-file:<file_id>` placeholder, never a token URL).
   * Read only for engaged messages, and only when the engaging message has
   * no attachment of its own. WhatsApp reads quoted media off the native
   * message instead; Discord and Matrix fetch the referenced message/event
   * lazily after the engagement decision.
   */
  quotedAudio?: { url: string; contentType: string; buffer?: Buffer; ptt?: boolean };

  /** Replied-to message's first non-audio attachment (see `quotedAudio`). */
  quotedMedia?: {
    url?: string;
    contentType: string;
    fileName?: string;
    buffer?: Buffer;
    kind: 'image' | 'video' | 'audio' | 'sticker' | 'document';
  };

  /**
   * True when the message carries an attachment the reply path can read
   * lazily off the platform-native message (e.g. a WhatsApp non-PTT audio
   * file) that is deliberately NOT surfaced on `audio`/`media`. It is
   * counted by the core no-content gate so the message reaches group
   * dispatch, where the platform collector reads the bytes strictly after
   * the engagement decision. Bridge relay capture DELIBERATELY ignores this
   * flag: such messages are not bridge-relayed (preserving the behavior
   * from before attachment reading existed), and nothing ever tries to
   * fetch a placeholder URL for them.
   */
  hasReadableAttachment?: boolean;

  /**
   * True when `text` is a processor-synthesized placeholder (a voice note
   * whose transcription failed became VOICE_NOTE_PLACEHOLDER). The message
   * still flows through moderation, recording, and bridge capture, but
   * reply dispatch skips it — keyed on this flag, never on text equality,
   * so a user who literally types "[voice note]" is unaffected.
   */
  synthesizedPlaceholder?: boolean;

  /** Platform-specific raw message for advanced operations. */
  raw: MessageRef;
}

/**
 * Shared placeholder for audio content that could not be transcribed.
 * Bridge relay capture uses the same literal for media placeholders.
 */
export const VOICE_NOTE_PLACEHOLDER = '[voice note]';
