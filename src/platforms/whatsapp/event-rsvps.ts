import {
  decryptEventResponse,
  getKeyAuthor,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';

import { logger } from '../../middleware/logger.js';
import {
  findWhatsAppNativeEventByMessageId,
  upsertNativeEventRsvp,
  type NativeEventRsvpResponse,
} from '../../utils/db.js';

/**
 * WhatsApp event RSVP ingestion.
 *
 * A member's RSVP to a native event message arrives as a message whose
 * content is `encEventResponseMessage`: an encrypted EventResponseMessage
 * plus the message key of the event creation message it answers. Baileys
 * only decrypts these itself when the socket is configured with a
 * `getMessage` store that can return the original event message (it needs
 * that message's `messageContextInfo.messageSecret` as the decryption key)
 * — this deployment keeps no such store, so the adapter embeds the secret
 * in the event's stored platform_ref at send time and this module decrypts
 * inbound responses directly.
 *
 * An RSVP is a protocol message, not a chat message: once recognized it is
 * consumed here and must never reach reply dispatch, moderation, stats,
 * memory extraction, or bridge capture.
 *
 * Known limitations (inherent to the replacement-message model):
 * - `!event move`/`rename` send a REPLACEMENT event message; only responses
 *   to the latest message match the stored ref. RSVPs made against an
 *   older, superseded event message are dropped (debug-logged).
 * - Events whose create was held by the safety layer get a real ref only
 *   when the owner releases the job (see `reconcileHeldNativeEventRef`);
 *   RSVPs arriving while the ref is still `{heldJobId:N}` are dropped.
 */

/**
 * Build the platform_ref JSON for a sent WhatsApp event message: the
 * message key plus the event's `messageSecret` (base64), which is the only
 * material that can decrypt member RSVPs later. Falls back to the historic
 * `{missingKey:true}` marker when Baileys returns no key.
 */
export function buildWhatsAppEventPlatformRef(sent: WAMessage | undefined): string {
  if (!sent?.key) return JSON.stringify({ missingKey: true });

  const secret = normalizeMessageContent(sent.message)?.messageContextInfo?.messageSecret;
  const ref: Record<string, unknown> = { ...sent.key };
  if (secret && secret.length > 0) {
    ref.messageSecret = Buffer.from(secret).toString('base64');
  }
  return JSON.stringify(ref);
}

/**
 * Detect and ingest an inbound event RSVP. Returns true when the message
 * was an RSVP (whether or not it matched an event) so the processor stops
 * before normal dispatch; false means "not an RSVP, continue as usual".
 * Ingestion failures are logged and swallowed — a malformed RSVP must
 * never crash message handling, and it is still not a chat message.
 */
export async function maybeIngestWhatsAppEventRsvp(sock: WASocket, msg: WAMessage): Promise<boolean> {
  const enc = normalizeMessageContent(msg.message)?.encEventResponseMessage;
  if (!enc) return false;

  try {
    await ingestEventRsvp(sock, msg, enc);
  } catch (err) {
    logger.warn({ err, msgId: msg.key.id }, 'Failed to ingest WhatsApp event RSVP');
  }
  return true;
}

async function ingestEventRsvp(
  sock: WASocket,
  msg: WAMessage,
  enc: proto.Message.IEncEventResponseMessage,
): Promise<void> {
  const creationKey = enc.eventCreationMessageKey;
  const chatId = creationKey?.remoteJid ?? msg.key.remoteJid;
  if (!creationKey?.id || !chatId) {
    logger.debug({ msgId: msg.key.id }, 'Event RSVP without a usable creation key — dropped');
    return;
  }

  const event = await findWhatsAppNativeEventByMessageId(chatId, creationKey.id);
  if (!event) {
    // Unknown event message: not one of ours, a superseded (pre-move/rename)
    // event message, or a held-create ref that has not been released yet.
    logger.debug({ msgId: msg.key.id, targetMessageId: creationKey.id }, 'Event RSVP for unknown event — dropped');
    return;
  }

  const eventEncKey = refMessageSecret(event.platformRef);
  if (!eventEncKey) {
    logger.debug({ eventId: event.id }, 'Event RSVP for event without a stored messageSecret — dropped');
    return;
  }
  if (!enc.encPayload || !enc.encIv) {
    logger.debug({ eventId: event.id }, 'Event RSVP without encrypted payload — dropped');
    return;
  }

  // The bot is always the creator of tracked events, so the creator jid in
  // the response's AAD is our own normalized PN jid (Baileys' reference
  // handling in process-message.js resolves the creator LID→PN the same way).
  const meId = jidNormalizedUser(sock.user?.id);
  const responderJid = getKeyAuthor(msg.key, meId);
  const response = decryptEventResponse(
    { encPayload: enc.encPayload, encIv: enc.encIv },
    { eventCreatorJid: meId, eventMsgId: creationKey.id, eventEncKey, responderJid },
  );

  const mapped = mapResponseType(response.response);
  if (!mapped) {
    logger.debug({ eventId: event.id, responseType: response.response }, 'Unrecognized event RSVP type — dropped');
    return;
  }

  await upsertNativeEventRsvp(event.id, responderJid, mapped, toEpochMs(response.timestampMs));
  logger.info({ eventId: event.id, response: mapped }, 'Recorded WhatsApp event RSVP');
}

function mapResponseType(
  type: proto.Message.EventResponseMessage.EventResponseType | null | undefined,
): NativeEventRsvpResponse | null {
  // Enum accessed inside the function (not at module scope) so importing
  // this module works under tests that partially mock Baileys.
  const types = proto.Message.EventResponseMessage.EventResponseType;
  switch (type) {
    case types.GOING:
      return 'going';
    case types.NOT_GOING:
      return 'not_going';
    case types.MAYBE:
      return 'maybe';
    default:
      return null;
  }
}

/** Extract the base64 messageSecret from a stored platform_ref, if present. */
function refMessageSecret(platformRef: string): Buffer | null {
  try {
    const parsed = JSON.parse(platformRef) as { messageSecret?: unknown } | null;
    if (parsed && typeof parsed.messageSecret === 'string' && parsed.messageSecret.length > 0) {
      return Buffer.from(parsed.messageSecret, 'base64');
    }
  } catch {
    // Unrecognized ref shape — treated as "no secret stored".
  }
  return null;
}

function toEpochMs(value: proto.Message.IEventResponseMessage['timestampMs']): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (value && typeof value === 'object') {
    const n = value.toNumber();
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Date.now();
}
