import {
  type WASocket,
  type WAMessage,
  type WAMessageContent,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';
import { hasVisualMedia } from './media.js';
import { getSenderJid, isGroupJid } from '../../utils/jid.js';
import type { InboundMessage } from '../../core/inbound-message.js';

export interface WhatsAppInbound extends InboundMessage {
  platform: 'whatsapp';
  raw: WAMessage;
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

export function normalizeWhatsAppInboundMessage(_sock: WASocket, msg: WAMessage): WhatsAppInbound | null {
  const chatId = msg.key.remoteJid;
  if (!chatId) return null;

  const content = unwrapWhatsAppMessage(msg);
  const text = extractWhatsAppText(content);
  const senderId = getSenderJid(chatId, msg.key.participant);

  const timestampSeconds = typeof msg.messageTimestamp === 'number'
    ? msg.messageTimestamp
    : Number(msg.messageTimestamp ?? 0);

  return {
    platform: 'whatsapp',
    chatId,
    senderId,
    messageId: msg.key.id ?? undefined,
    fromSelf: !!msg.key.fromMe,
    isStatusBroadcast: chatId === 'status@broadcast',
    isGroupChat: isGroupJid(chatId),
    timestampMs: timestampSeconds > 0 ? timestampSeconds * 1000 : Date.now(),
    text,
    quotedText: extractWhatsAppQuotedText(content),
    mentionedIds: extractWhatsAppMentionedJids(content),
    hasVisualMedia: hasVisualMedia(msg),
    raw: msg,
    content,
  };
}
