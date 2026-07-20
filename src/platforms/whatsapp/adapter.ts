import type { WASocket, PollMessageOptions, EventMessageOptions } from '@whiskeysockets/baileys';
import type { MessageRef } from '../../core/message-ref.js';
import { createWhatsAppSentMessageRef, getDeleteKey, getQuotedWAMessage } from './message-ref.js';
import type { PollPayload } from '../../core/poll-payload.js';
import type { PlatformMessenger, NativeEventPayload } from '../../core/platform-messenger.js';

/**
 * Map the platform-agnostic native-event payload onto the Baileys event
 * message shape. WhatsApp event messages carry the location as a
 * LocationMessage proto; all its fields are optional, so a name-only
 * location (free text, no coordinates) is valid.
 */
function toEventMessageOptions(event: NativeEventPayload, isCancelled: boolean): EventMessageOptions {
  return {
    name: event.name,
    description: event.description,
    startDate: new Date(event.startAtMs),
    endDate: event.endAtMs === undefined ? undefined : new Date(event.endAtMs),
    location: event.location ? { name: event.location } : undefined,
    isCancelled,
  };
}

export function createWhatsAppAdapter(sock: WASocket): PlatformMessenger {
  return {
    platform: 'whatsapp',

    // Baileys has no supported way to edit an event message in place (the
    // `{ event }` content branch is not Editable, and regenerating an event
    // creates a fresh messageSecret, which would orphan existing RSVPs), so
    // update/cancel send a corrected replacement event message and return
    // the NEW message key as the ref. Sends go through the outbound-safety
    // proxy wrapping `sock.sendMessage`; a WhatsAppOutboundHeldError from it
    // means "queued for manual release", not failure — callers surface it
    // that way.
    async createNativeEvent(chatId: string, event: NativeEventPayload): Promise<string> {
      const sent = await sock.sendMessage(chatId, { event: toEventMessageOptions(event, false) });
      // Send succeeded; a missing key is a Baileys edge case, and the ref is unused for WA update/cancel (replacement sends).
      return JSON.stringify(sent?.key ?? { missingKey: true });
    },

    async updateNativeEvent(chatId: string, _ref: string, event: NativeEventPayload): Promise<string> {
      const sent = await sock.sendMessage(chatId, { event: toEventMessageOptions(event, false) });
      // Send succeeded; a missing key is a Baileys edge case, and the ref is unused for WA update/cancel (replacement sends).
      return JSON.stringify(sent?.key ?? { missingKey: true });
    },

    async cancelNativeEvent(chatId: string, _ref: string, event: NativeEventPayload): Promise<void> {
      await sock.sendMessage(chatId, { event: toEventMessageOptions(event, true) });
    },

    async sendText(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<void> {
      const quoted = getQuotedWAMessage(options?.replyTo);
      await sock.sendMessage(chatId, { text }, quoted ? { quoted } : undefined);
    },

    async sendTextWithRef(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<MessageRef> {
      const quoted = getQuotedWAMessage(options?.replyTo);
      const sent = await sock.sendMessage(chatId, { text }, quoted ? { quoted } : undefined);
      return createWhatsAppSentMessageRef(chatId, sent);
    },

    async sendPoll(chatId: string, poll: PollPayload): Promise<void> {
      // Map the core poll payload into the Baileys poll message shape.
      const payload: PollMessageOptions = {
        name: poll.name,
        values: poll.values,
        selectableCount: poll.selectableCount,
      };

      await sock.sendMessage(chatId, { poll: payload });
    },

    async sendDocument(chatId: string, doc: { bytes: Uint8Array; mimetype: string; fileName: string }): Promise<MessageRef> {
      const sent = await sock.sendMessage(chatId, {
        document: Buffer.from(doc.bytes),
        mimetype: doc.mimetype,
        fileName: doc.fileName,
      });

      return createWhatsAppSentMessageRef(chatId, sent);
    },

    async sendAudio(chatId: string, audio: { bytes: Uint8Array; mimetype: string; ptt?: boolean }, options?: { replyTo?: MessageRef }): Promise<void> {
      const quoted = getQuotedWAMessage(options?.replyTo);

      await sock.sendMessage(chatId, {
        audio: Buffer.from(audio.bytes),
        mimetype: audio.mimetype,
        ptt: audio.ptt ?? true,
      }, quoted ? { quoted } : undefined);
    },

    async deleteMessage(chatId: string, messageRef: MessageRef): Promise<void> {
      const key = getDeleteKey(messageRef);
      if (!key) return;
      await sock.sendMessage(chatId, { delete: key });
    },
  };
}
