/**
 * Telegram native events — honest announcement messages, not calendar
 * objects. The Telegram Bot API has no calendar/event primitive, so
 * `!event` posts a formatted announcement message and remembers its
 * message id as the platform ref (`{"chatId":...,"messageId":...}`).
 * Update edits the SAME message in place (`editMessageText` — bots may
 * edit their own messages indefinitely) so no replacement messages pile
 * up; cancel edits it to a clearly cancelled rendering. If the
 * announcement was deleted out from under us (admin cleanup, bot-message
 * removal), an update REPOSTS it with the create rendering and returns
 * the new ref so the event stays editable; a cancel just succeeds — there
 * is nothing left to edit and nobody left to see a cancellation notice.
 *
 * Pinning is best-effort: when the bot has the pin-messages right the
 * announcement is pinned on create (without a notification ping) and
 * unpinned on cancel. Missing rights are an expected deployment state, so
 * pin/unpin failures degrade silently — the announcement itself is the
 * feature, the pin is a nicety.
 */

import type { NativeEventPayload } from '../../core/platform-messenger.js';
import { buildEventAnnouncementText } from '../../core/event-announcement.js';
import { logger } from '../../middleware/logger.js';

import {
  editTelegramMarkdown,
  isTelegramMessageNotFoundError,
  sendTelegramMarkdown,
  telegramApiRequest,
} from './api.js';

export interface TelegramEventRef {
  chatId: string;
  messageId: number;
}

export function parseTelegramEventRef(ref: string): TelegramEventRef {
  try {
    const parsed = JSON.parse(ref) as Partial<TelegramEventRef> | null;
    if (parsed && typeof parsed.chatId === 'string' && typeof parsed.messageId === 'number') {
      return { chatId: parsed.chatId, messageId: parsed.messageId };
    }
  } catch {
    // fall through to the shared error below
  }
  throw new Error('Unrecognized Telegram event reference');
}

export interface TelegramNativeEventMethods {
  createNativeEvent(chatId: string, event: NativeEventPayload): Promise<string>;
  updateNativeEvent(chatId: string, ref: string, event: NativeEventPayload): Promise<string>;
  cancelNativeEvent(chatId: string, ref: string, event: NativeEventPayload): Promise<void>;
}

export function createTelegramNativeEventMethods(token: string): TelegramNativeEventMethods {
  async function setPinned(chatId: string, messageId: number, pinned: boolean): Promise<void> {
    try {
      await telegramApiRequest<boolean>(token, pinned ? 'pinChatMessage' : 'unpinChatMessage', {
        chat_id: chatId,
        message_id: messageId,
        ...(pinned ? { disable_notification: true } : {}),
      });
    } catch (err) {
      // Silent degrade (see file header): most commonly the bot lacks the
      // can_pin_messages right. Debug, not warn — this fires per event on
      // every deployment without the right, which is a fine way to run.
      logger.debug({ err, chatId, messageId, pinned }, 'Telegram event announcement pin/unpin skipped');
    }
  }

  return {
    async createNativeEvent(chatId: string, event: NativeEventPayload): Promise<string> {
      const sent = await sendTelegramMarkdown(token, chatId, buildEventAnnouncementText(event));
      await setPinned(chatId, sent.message_id, true);
      return JSON.stringify({ chatId, messageId: sent.message_id });
    },

    async updateNativeEvent(_chatId: string, ref: string, event: NativeEventPayload): Promise<string> {
      const { chatId, messageId } = parseTelegramEventRef(ref);
      try {
        await editTelegramMarkdown(token, chatId, messageId, buildEventAnnouncementText(event));
      } catch (err) {
        if (!isTelegramMessageNotFoundError(err)) throw err;
        // The announcement was deleted. Repost it exactly like create —
        // same rendering, same best-effort pin — and return the NEW ref;
        // the feature layer persists the returned ref, so future edits
        // target the live repost instead of dying on the dead message id.
        logger.warn({ chatId, messageId }, 'Telegram event announcement was deleted — reposting');
        const sent = await sendTelegramMarkdown(token, chatId, buildEventAnnouncementText(event));
        await setPinned(chatId, sent.message_id, true);
        return JSON.stringify({ chatId, messageId: sent.message_id });
      }
      // Edited in place — the ref (same message) never changes.
      return JSON.stringify({ chatId, messageId });
    },

    async cancelNativeEvent(_chatId: string, ref: string, event: NativeEventPayload): Promise<void> {
      const { chatId, messageId } = parseTelegramEventRef(ref);
      try {
        await editTelegramMarkdown(token, chatId, messageId, buildEventAnnouncementText(event, { cancelled: true }));
      } catch (err) {
        if (!isTelegramMessageNotFoundError(err)) throw err;
        // Nothing to edit and nobody can see it — success, so the caller
        // still cancels the row. No repost of a cancellation notice for a
        // message that no longer exists; deleting it also removed any pin.
        logger.debug({ chatId, messageId }, 'Telegram event announcement already deleted — cancel is a no-op');
        return;
      }
      await setPinned(chatId, messageId, false);
    },
  };
}
