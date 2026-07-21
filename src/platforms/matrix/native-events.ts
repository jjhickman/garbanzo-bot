/**
 * Matrix native events — honest announcement messages, not calendar
 * objects. Matrix has no stable native event type (calendar events are
 * unaccepted MSCs), so `!event` posts a formatted `m.room.message`
 * (body + formatted_body per the repo's markdown conventions) and
 * remembers the event id as the platform ref
 * (`{"roomId":...,"eventId":...}`).
 *
 * Update and cancel send an `m.replace` edit (MSC2676: `m.new_content`
 * plus `m.relates_to` with `rel_type: "m.replace"`). Every edit targets
 * the ORIGINAL announcement's event id — per spec, an edit of an edit
 * still references the original — so the ref never changes and no
 * replacement messages pile up. Rate limiting reuses the adapter's shared
 * M_LIMIT_EXCEEDED handling (inline retry within the direct-send budget,
 * throw beyond it).
 */

import type { NativeEventPayload } from '../../core/platform-messenger.js';
import { buildEventAnnouncementText } from '../../core/event-announcement.js';

import { toMatrixMessageContent } from './markdown.js';
import type { MatrixSendClient } from './adapter.js';

export interface MatrixEventRef {
  roomId: string;
  eventId: string;
}

export function parseMatrixEventRef(ref: string): MatrixEventRef {
  try {
    const parsed = JSON.parse(ref) as Partial<MatrixEventRef> | null;
    if (parsed && typeof parsed.roomId === 'string' && typeof parsed.eventId === 'string') {
      return { roomId: parsed.roomId, eventId: parsed.eventId };
    }
  } catch {
    // fall through to the shared error below
  }
  throw new Error('Unrecognized Matrix event reference');
}

/**
 * Build the m.replace edit content for an announcement. The top-level
 * body/formatted_body are the spec's fallback rendering (a `* `-prefixed
 * copy) for clients without edit support; `m.new_content` carries the real
 * replacement.
 */
export function buildMatrixEditContent(
  roomId: string,
  targetEventId: string,
  text: string,
): Record<string, unknown> {
  const content = toMatrixMessageContent(roomId, text);
  return {
    msgtype: content.msgtype,
    body: `* ${content.body}`,
    format: content.format,
    formatted_body: `* ${content.formatted_body}`,
    'm.new_content': {
      msgtype: content.msgtype,
      body: content.body,
      format: content.format,
      formatted_body: content.formatted_body,
    },
    'm.relates_to': { rel_type: 'm.replace', event_id: targetEventId },
  };
}

export interface MatrixNativeEventMethods {
  createNativeEvent(chatId: string, event: NativeEventPayload): Promise<string>;
  updateNativeEvent(chatId: string, ref: string, event: NativeEventPayload): Promise<string>;
  cancelNativeEvent(chatId: string, ref: string, event: NativeEventPayload): Promise<void>;
}

export function createMatrixNativeEventMethods(
  client: MatrixSendClient,
  request: <T>(method: string, action: () => Promise<T>) => Promise<T>,
): MatrixNativeEventMethods {
  async function sendEdit(ref: string, text: string): Promise<MatrixEventRef> {
    const parsed = parseMatrixEventRef(ref);
    await request('sendMessage', () => client.sendMessage(
      parsed.roomId,
      buildMatrixEditContent(parsed.roomId, parsed.eventId, text),
    ));
    return parsed;
  }

  return {
    async createNativeEvent(roomId: string, event: NativeEventPayload): Promise<string> {
      const sent = await request('sendMessage', () => client.sendMessage(
        roomId,
        toMatrixMessageContent(roomId, buildEventAnnouncementText(event)),
      ));
      const eventId = typeof sent === 'string' ? sent : sent.event_id ?? '';
      return JSON.stringify({ roomId, eventId });
    },

    async updateNativeEvent(_chatId: string, ref: string, event: NativeEventPayload): Promise<string> {
      // Edited in place via m.replace — the ref (original event) never changes.
      const parsed = await sendEdit(ref, buildEventAnnouncementText(event));
      return JSON.stringify(parsed);
    },

    async cancelNativeEvent(_chatId: string, ref: string, event: NativeEventPayload): Promise<void> {
      await sendEdit(ref, buildEventAnnouncementText(event, { cancelled: true }));
    },
  };
}
