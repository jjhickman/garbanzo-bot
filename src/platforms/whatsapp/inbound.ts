import {
  type WASocket,
  type WAMessage,
  type WAMessageContent,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';
import { hasVisualMedia } from './media.js';
import { getSenderJid, isGroupJid, isLidJid } from '../../utils/jid.js';
import type { InboundMessage } from '../../core/inbound-message.js';
import type { MessageRef } from '../../core/message-ref.js';
import { createWhatsAppInboundMessageRef } from './message-ref.js';

type MessageKeyWithLegacyPn = WAMessage['key'] & {
  senderPn?: string;
  participantPn?: string;
};

export interface WhatsAppInbound extends InboundMessage {
  platform: 'whatsapp';

  /** Native Baileys message, for WhatsApp-specific handling. */
  waMessage: WAMessage;

  /** Platform/core seam reference. */
  raw: MessageRef;

  content: WAMessageContent | undefined;
}

/**
 * Unwrap the message content, handling ephemeral/viewOnce/protocol wrappers
 * that WhatsApp applies in groups with disappearing messages etc.
 */
export function unwrapWhatsAppMessage(msg: WAMessage): WAMessageContent | undefined {
  return normalizeMessageContent(msg.message);
}

/** Extract text content from unwrapped message content */
export function extractWhatsAppText(content: WAMessageContent | undefined): string | null {
  if (!content) return null;

  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    null
  );
}

/** Extract quoted/replied-to text if present */
export function extractWhatsAppQuotedText(content: WAMessageContent | undefined): string | undefined {
  const quoted = content?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) return undefined;
  const unwrapped = normalizeMessageContent(quoted);
  return extractWhatsAppText(unwrapped) ?? undefined;
}

/** Extract JIDs mentioned via WhatsApp's native @mention system */
export function extractWhatsAppMentionedJids(content: WAMessageContent | undefined): string[] | undefined {
  if (!content) return undefined;
  const ctx = content.extendedTextMessage?.contextInfo
    ?? content.imageMessage?.contextInfo
    ?? content.videoMessage?.contextInfo
    ?? content.documentMessage?.contextInfo;
  const jids = ctx?.mentionedJid;
  if (!jids || jids.length === 0) return undefined;
  return jids;
}

/**
 * Resolve the sender to a phone-number JID when WhatsApp delivers a LID
 * (privacy alias, `<n>@lid`). The message key carries the real phone JID in
 * `participantAlt` (groups) / `remoteJidAlt` (DMs) in Baileys v7, with
 * `participantPn` / `senderPn` retained as v6 fallbacks. Preferring it keeps
 * owner matching, rate-limit exemption, and profile/strike keys stable
 * regardless of which form WhatsApp chose for this message.
 */
export function resolveWhatsAppSenderJid(msg: WAMessage, chatId: string): string {
  const key = msg.key as MessageKeyWithLegacyPn;
  const sender = getSenderJid(chatId, key.participant);
  if (!isLidJid(sender)) return sender;
  if (isGroupJid(chatId)) return key.participantAlt ?? key.participantPn ?? sender;
  return key.remoteJidAlt ?? key.senderPn ?? sender;
}

function cleanOptionalName(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

// proto.Message.ProtocolMessage.Type.MESSAGE_EDIT — an incoming edit arrives
// as a protocolMessage envelope that normalizeMessageContent does NOT unwrap
// (it only unwraps ephemeral/viewOnce/editedMessage wrappers on outbound).
const PROTOCOL_MESSAGE_EDIT = 14;

/**
 * Detect an incoming message edit and unwrap the replacement content.
 * Returns the edited content + the original message id, or null when the
 * message is not an edit.
 */
export function unwrapWhatsAppEdit(
  content: WAMessageContent | undefined,
): { content: WAMessageContent | undefined; editOfMessageId: string | undefined } | null {
  const protocol = content?.protocolMessage;
  if (!protocol || protocol.type !== PROTOCOL_MESSAGE_EDIT || !protocol.editedMessage) return null;
  return {
    content: normalizeMessageContent(protocol.editedMessage),
    editOfMessageId: protocol.key?.id ?? undefined,
  };
}

export function normalizeWhatsAppInboundMessage(_sock: WASocket, msg: WAMessage): WhatsAppInbound | null {
  const chatId = msg.key.remoteJid;
  if (!chatId) return null;

  let content = unwrapWhatsAppMessage(msg);
  const edit = unwrapWhatsAppEdit(content);
  if (edit) content = edit.content;
  const text = extractWhatsAppText(content);
  const senderId = resolveWhatsAppSenderJid(msg, chatId);

  const timestampSeconds = typeof msg.messageTimestamp === 'number'
    ? msg.messageTimestamp
    : Number(msg.messageTimestamp ?? 0);

  // MessageRef id generation handled by helper.

  return {
    platform: 'whatsapp',
    chatId,
    senderId,
    senderName: cleanOptionalName(msg.pushName),
    messageId: msg.key.id ?? undefined,
    editOfMessageId: edit?.editOfMessageId,
    fromSelf: !!msg.key.fromMe,
    isStatusBroadcast: chatId === 'status@broadcast',
    isGroupChat: isGroupJid(chatId),
    timestampMs: timestampSeconds > 0 ? timestampSeconds * 1000 : Date.now(),
    text,
    quotedText: extractWhatsAppQuotedText(content),
    mentionedIds: extractWhatsAppMentionedJids(content),
    hasVisualMedia: hasVisualMedia(msg),
    waMessage: msg,
    raw: createWhatsAppInboundMessageRef(chatId, msg),
    content,
  };
}
