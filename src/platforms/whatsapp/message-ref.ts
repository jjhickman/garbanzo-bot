import type { WAMessage, WAMessageKey } from '@whiskeysockets/baileys';

import { createMessageRef, type MessageRef } from '../../core/message-ref.js';

export interface WhatsAppRefData {
  kind: 'whatsapp';
  key: WAMessageKey;
  message?: WAMessage['message'];
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createWhatsAppInboundMessageRef(chatId: string, msg: WAMessage): MessageRef {
  const id = msg.key.id ?? randomId('wa');

  const ref: WhatsAppRefData = {
    kind: 'whatsapp',
    key: msg.key,
    message: msg.message,
  };

  return createMessageRef({
    platform: 'whatsapp',
    chatId,
    id,
    ref,
  });
}

export function createWhatsAppSentMessageRef(chatId: string, sent: { key: WAMessageKey } | undefined): MessageRef {
  const ref: WhatsAppRefData = {
    kind: 'whatsapp',
    key: sent?.key ?? { remoteJid: chatId, id: randomId('wa-sent') },
  };

  return createMessageRef({
    platform: 'whatsapp',
    chatId,
    id: sent?.key.id ?? randomId('wa-sent'),
    ref,
  });
}

export function isWhatsAppRefData(value: unknown): value is WhatsAppRefData {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.kind !== 'whatsapp') return false;
  return typeof v.key === 'object' && v.key !== null;
}

export function getQuotedWAMessage(ref: MessageRef | undefined): WAMessage | undefined {
  if (!ref) return undefined;
  if (ref.platform !== 'whatsapp') return undefined;
  if (!isWhatsAppRefData(ref.ref)) return undefined;

  const data = ref.ref;
  // Baileys expects a WAMessage for quoting. A minimal object with `key` and
  // `message` is sufficient for our usage.
  return {
    key: data.key,
    message: data.message,
  } as unknown as WAMessage;
}

export function getDeleteKey(ref: MessageRef | undefined): WAMessageKey | undefined {
  if (!ref) return undefined;
  if (ref.platform !== 'whatsapp') return undefined;
  if (!isWhatsAppRefData(ref.ref)) return undefined;
  return ref.ref.key;
}
