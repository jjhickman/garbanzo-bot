process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { randomBytes } from 'node:crypto';

import { aesEncryptGCM, hmacSign, proto } from '@whiskeysockets/baileys';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleNativeEventCommand } from '../src/features/native-events.js';
import type { PlatformMessenger } from '../src/core/platform-messenger.js';
import {
  addNativeEvent,
  countNativeEventRsvps,
  findWhatsAppNativeEventByMessageId,
  getNativeEventById,
  listNativeEventRsvps,
  reconcileHeldNativeEventRef,
  upsertNativeEventRsvp,
} from '../src/utils/db.js';

// Test JIDs use the documented fake-number convention (5550001234-style).
const BOT_JID = '15550009999@s.whatsapp.net';
const MEMBER_1 = '15550001111@s.whatsapp.net';
const MEMBER_2 = '15550002222@s.whatsapp.net';

const RESPONSE_TYPES = proto.Message.EventResponseMessage.EventResponseType;

let uniqueCounter = 0;
function nextId(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}-${process.pid}-${uniqueCounter}`;
}

function makeWhatsAppEvent(chatId: string, platformRef: string) {
  return addNativeEvent({
    chatId,
    platform: 'whatsapp',
    name: 'Trivia Night',
    description: null,
    location: null,
    startAtMs: Date.now() + 24 * 60 * 60 * 1000,
    endAtMs: null,
    platformRef,
    createdBy: 'test_owner@s.whatsapp.net',
  });
}

function eventRef(chatId: string, messageId: string, secret?: Buffer): string {
  return JSON.stringify({
    remoteJid: chatId,
    fromMe: true,
    id: messageId,
    ...(secret ? { messageSecret: secret.toString('base64') } : {}),
  });
}

/**
 * Produce a REAL encrypted event response exactly as a member's client
 * would (mirrors Baileys' decryptEventResponse in
 * lib/Utils/process-message.js: HMAC key chain over the event message
 * secret, then AES-256-GCM with the `${eventMsgId}\0${responderJid}` AAD).
 */
function encryptRsvp(options: {
  eventMsgId: string;
  responderJid: string;
  secret: Buffer;
  response: number;
  timestampMs?: number;
}): { encPayload: Uint8Array; encIv: Uint8Array } {
  const payload = proto.Message.EventResponseMessage.encode({
    response: options.response,
    timestampMs: options.timestampMs ?? Date.now(),
  }).finish();
  const sign = Buffer.concat([
    Buffer.from(options.eventMsgId),
    Buffer.from(BOT_JID),
    Buffer.from(options.responderJid),
    Buffer.from('Event Response'),
    Uint8Array.from([1]),
  ]);
  const key0 = hmacSign(options.secret, new Uint8Array(32), 'sha256');
  const encKey = hmacSign(sign, key0, 'sha256');
  const encIv = randomBytes(12);
  const aad = Buffer.from(`${options.eventMsgId}\u0000${options.responderJid}`);
  const encPayload = aesEncryptGCM(payload, encKey, encIv, aad);
  return { encPayload: new Uint8Array(encPayload), encIv: new Uint8Array(encIv) };
}

function rsvpWaMessage(
  chatId: string,
  eventMsgId: string,
  responderJid: string,
  enc: { encPayload: Uint8Array; encIv: Uint8Array },
) {
  return {
    key: { remoteJid: chatId, id: nextId('rsvp'), participant: responderJid, fromMe: false },
    message: {
      encEventResponseMessage: {
        eventCreationMessageKey: { remoteJid: chatId, id: eventMsgId, fromMe: true },
        encPayload: enc.encPayload,
        encIv: enc.encIv,
      },
    },
  };
}

// ── Storage ─────────────────────────────────────────────────────────

describe('native_event_rsvps storage', () => {
  it('overwrites a repeat response from the same sender (change of mind)', async () => {
    const event = await makeWhatsAppEvent(nextId('chat'), eventRef('c', nextId('msg')));

    await upsertNativeEventRsvp(event.id, MEMBER_1, 'going', 1000);
    await upsertNativeEventRsvp(event.id, MEMBER_1, 'maybe', 2000);

    const rsvps = await listNativeEventRsvps(event.id);
    expect(rsvps).toHaveLength(1);
    expect(rsvps[0]).toMatchObject({ senderJid: MEMBER_1, response: 'maybe', respondedAt: 2000 });
    expect(await countNativeEventRsvps(event.id)).toEqual({ going: 0, notGoing: 0, maybe: 1 });
  });

  it('ignores an older-timestamped response replayed after a newer one (history-sync replay)', async () => {
    const event = await makeWhatsAppEvent(nextId('chat'), eventRef('c', nextId('msg')));

    await upsertNativeEventRsvp(event.id, MEMBER_1, 'going', 2000);
    // A replayed/reordered older response (e.g. via Baileys history sync
    // through the catch-up path) must not clobber the newer answer.
    await upsertNativeEventRsvp(event.id, MEMBER_1, 'not_going', 1000);

    const rsvps = await listNativeEventRsvps(event.id);
    expect(rsvps).toHaveLength(1);
    expect(rsvps[0]).toMatchObject({ senderJid: MEMBER_1, response: 'going', respondedAt: 2000 });
  });

  it('lets an equal-timestamped response overwrite (last write wins on ties)', async () => {
    const event = await makeWhatsAppEvent(nextId('chat'), eventRef('c', nextId('msg')));

    await upsertNativeEventRsvp(event.id, MEMBER_1, 'going', 1500);
    await upsertNativeEventRsvp(event.id, MEMBER_1, 'maybe', 1500);

    const rsvps = await listNativeEventRsvps(event.id);
    expect(rsvps).toHaveLength(1);
    expect(rsvps[0]).toMatchObject({ senderJid: MEMBER_1, response: 'maybe', respondedAt: 1500 });
  });

  it('keeps RSVPs isolated per event', async () => {
    const eventA = await makeWhatsAppEvent(nextId('chat'), eventRef('c', nextId('msg')));
    const eventB = await makeWhatsAppEvent(nextId('chat'), eventRef('c', nextId('msg')));

    await upsertNativeEventRsvp(eventA.id, MEMBER_1, 'going', 1000);
    await upsertNativeEventRsvp(eventA.id, MEMBER_2, 'not_going', 1000);
    await upsertNativeEventRsvp(eventB.id, MEMBER_1, 'maybe', 1000);

    expect(await countNativeEventRsvps(eventA.id)).toEqual({ going: 1, notGoing: 1, maybe: 0 });
    expect(await countNativeEventRsvps(eventB.id)).toEqual({ going: 0, notGoing: 0, maybe: 1 });
  });

  it('finds a WhatsApp event by chat + event message id via the stored ref', async () => {
    const chatId = nextId('chat');
    const messageId = nextId('msg');
    const event = await makeWhatsAppEvent(chatId, eventRef(chatId, messageId, randomBytes(32)));

    expect((await findWhatsAppNativeEventByMessageId(chatId, messageId))?.id).toBe(event.id);
    expect(await findWhatsAppNativeEventByMessageId(chatId, 'no-such-message')).toBeUndefined();
    expect(await findWhatsAppNativeEventByMessageId(nextId('other-chat'), messageId)).toBeUndefined();
  });

  it('never matches held ({heldJobId}) or {missingKey} refs', async () => {
    const chatId = nextId('chat');
    await makeWhatsAppEvent(chatId, JSON.stringify({ heldJobId: 41 }));
    await makeWhatsAppEvent(chatId, JSON.stringify({ missingKey: true }));

    expect(await findWhatsAppNativeEventByMessageId(chatId, 'anything')).toBeUndefined();
  });

  it('reconciles exactly the matching held ref and only once', async () => {
    const chatId = nextId('chat');
    const heldEvent = await makeWhatsAppEvent(chatId, JSON.stringify({ heldJobId: 4242 }));
    const otherEvent = await makeWhatsAppEvent(chatId, eventRef(chatId, nextId('msg')));
    const newMessageId = nextId('msg');
    const newRef = eventRef(chatId, newMessageId, randomBytes(32));

    expect(await reconcileHeldNativeEventRef(4242, newRef)).toBe(true);
    expect((await getNativeEventById(heldEvent.id))?.platformRef).toBe(newRef);
    expect((await getNativeEventById(otherEvent.id))?.platformRef).toBe(otherEvent.platformRef);
    // Once repointed, the placeholder no longer exists to reconcile.
    expect(await reconcileHeldNativeEventRef(4242, newRef)).toBe(false);
    // And RSVPs sent after release now resolve to the event.
    expect((await findWhatsAppNativeEventByMessageId(chatId, newMessageId))?.id).toBe(heldEvent.id);
  });
});

// ── WhatsApp ingestion through the real processor ───────────────────

describe('WhatsApp RSVP ingestion (real processor path, Baileys boundary mocked)', () => {
  const processInboundMessage = vi.fn(async () => undefined);
  const normalizeWhatsAppInboundMessage = vi.fn(() => ({
    platform: 'whatsapp',
    chatId: 'group@g.us',
    senderId: MEMBER_1,
    messageId: 'm1',
    fromSelf: false,
    isStatusBroadcast: false,
    isGroupChat: true,
    timestampMs: Date.now(),
    text: 'hello',
    hasVisualMedia: false,
    raw: { platform: 'whatsapp', chatId: 'group@g.us', id: 'm1' },
    waMessage: {},
    content: undefined,
  }));
  const captureForBridge = vi.fn();

  function setupProcessorMocks() {
    vi.doMock('../src/core/process-inbound-message.js', () => ({ processInboundMessage }));
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../src/middleware/health.js', () => ({ markMessageReceived: vi.fn() }));
    vi.doMock('../src/platforms/whatsapp/media.js', () => ({
      isVoiceMessage: vi.fn(() => false),
      classifyDirectAudio: vi.fn(() => null),
      downloadVoiceAudio: vi.fn(async () => null),
    }));
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio: vi.fn(async () => null) }));
    vi.doMock('../src/features/introductions.js', () => ({ handleIntroduction: vi.fn(async () => null) }));
    vi.doMock('../src/features/events.js', () => ({ handleEventPassive: vi.fn(async () => null) }));
    vi.doMock('../src/core/groups-config.js', () => ({
      isGroupEnabled: vi.fn(() => true),
      getEnabledGroupJidByName: vi.fn(() => null),
    }));
    vi.doMock('../src/platforms/whatsapp/owner-commands.js', () => ({ handleOwnerDM: vi.fn(async () => undefined) }));
    vi.doMock('../src/platforms/whatsapp/group-handler.js', () => ({ handleGroupMessage: vi.fn(async () => undefined) }));
    vi.doMock('../src/platforms/whatsapp/reactions.js', () => ({
      isReplyToBot: vi.fn(() => false),
      isAcknowledgment: vi.fn(() => false),
    }));
    vi.doMock('../src/platforms/whatsapp/inbound.js', () => ({ normalizeWhatsAppInboundMessage }));
    vi.doMock('../src/platforms/whatsapp/adapter.js', () => ({
      createWhatsAppAdapter: vi.fn(() => ({ sendText: vi.fn(async () => undefined) })),
    }));
    vi.doMock('../src/platforms/whatsapp/outbound-safety.js', () => ({
      getWhatsAppOutboundSafety: vi.fn(() => undefined),
    }));
    vi.doMock('../src/bridge/capture-hook.js', () => ({ captureForBridge }));
  }

  // The bot's raw socket id carries a device suffix; ingestion must
  // normalize it to the plain PN jid the responder's client signed.
  const sock = { user: { id: '15550009999:3@s.whatsapp.net' } };

  beforeEach(() => {
    vi.resetModules();
    processInboundMessage.mockClear();
    normalizeWhatsAppInboundMessage.mockClear();
    captureForBridge.mockClear();
    setupProcessorMocks();
  });

  async function loadProcessor() {
    const [{ processWhatsAppRawMessage }, db] = await Promise.all([
      import('../src/platforms/whatsapp/processor.js'),
      import('../src/utils/db.js'),
    ]);
    return { processWhatsAppRawMessage, db };
  }

  it('ingests a member RSVP without letting it reach dispatch, moderation, or bridge capture', async () => {
    const { processWhatsAppRawMessage, db } = await loadProcessor();
    const chatId = nextId('chat');
    const eventMsgId = nextId('msg');
    const secret = randomBytes(32);
    const event = await db.addNativeEvent({
      chatId,
      platform: 'whatsapp',
      name: 'Trivia Night',
      description: null,
      location: null,
      startAtMs: Date.now() + 86_400_000,
      endAtMs: null,
      platformRef: eventRef(chatId, eventMsgId, secret),
      createdBy: 'test_owner@s.whatsapp.net',
    });

    const enc = encryptRsvp({ eventMsgId, responderJid: MEMBER_1, secret, response: RESPONSE_TYPES.GOING, timestampMs: 1234 });
    await processWhatsAppRawMessage(sock as never, rsvpWaMessage(chatId, eventMsgId, MEMBER_1, enc) as never);

    const rsvps = await db.listNativeEventRsvps(event.id);
    expect(rsvps).toEqual([
      { eventId: event.id, senderJid: MEMBER_1, response: 'going', respondedAt: 1234 },
    ]);
    // The invariant: an RSVP is protocol traffic, never a chat message.
    // It must not be normalized/dispatched (replies, moderation, stats,
    // memory) nor captured for bridge relay.
    expect(normalizeWhatsAppInboundMessage).not.toHaveBeenCalled();
    expect(processInboundMessage).not.toHaveBeenCalled();
    expect(captureForBridge).not.toHaveBeenCalled();
  });

  it('overwrites the same member\'s earlier answer on a second response', async () => {
    const { processWhatsAppRawMessage, db } = await loadProcessor();
    const chatId = nextId('chat');
    const eventMsgId = nextId('msg');
    const secret = randomBytes(32);
    const event = await makeWhatsAppEventVia(db, chatId, eventRef(chatId, eventMsgId, secret));

    const going = encryptRsvp({ eventMsgId, responderJid: MEMBER_1, secret, response: RESPONSE_TYPES.GOING, timestampMs: 1000 });
    await processWhatsAppRawMessage(sock as never, rsvpWaMessage(chatId, eventMsgId, MEMBER_1, going) as never);
    const changed = encryptRsvp({ eventMsgId, responderJid: MEMBER_1, secret, response: RESPONSE_TYPES.NOT_GOING, timestampMs: 2000 });
    await processWhatsAppRawMessage(sock as never, rsvpWaMessage(chatId, eventMsgId, MEMBER_1, changed) as never);

    const rsvps = await db.listNativeEventRsvps(event.id);
    expect(rsvps).toHaveLength(1);
    expect(rsvps[0]).toMatchObject({ senderJid: MEMBER_1, response: 'not_going', respondedAt: 2000 });
  });

  it('drops an RSVP for an unknown event message quietly (no dispatch either)', async () => {
    const { processWhatsAppRawMessage, db } = await loadProcessor();
    const chatId = nextId('chat');
    const bystander = await makeWhatsAppEventVia(db, chatId, eventRef(chatId, nextId('msg'), randomBytes(32)));

    const enc = encryptRsvp({ eventMsgId: 'never-sent', responderJid: MEMBER_1, secret: randomBytes(32), response: RESPONSE_TYPES.GOING });
    await processWhatsAppRawMessage(sock as never, rsvpWaMessage(chatId, 'never-sent', MEMBER_1, enc) as never);

    expect(await db.listNativeEventRsvps(bystander.id)).toEqual([]);
    expect(processInboundMessage).not.toHaveBeenCalled();
    expect(captureForBridge).not.toHaveBeenCalled();
  });

  it('drops an RSVP whose payload does not decrypt with the stored secret', async () => {
    const { processWhatsAppRawMessage, db } = await loadProcessor();
    const chatId = nextId('chat');
    const eventMsgId = nextId('msg');
    const event = await makeWhatsAppEventVia(db, chatId, eventRef(chatId, eventMsgId, randomBytes(32)));

    const wrongSecret = encryptRsvp({ eventMsgId, responderJid: MEMBER_1, secret: randomBytes(32), response: RESPONSE_TYPES.GOING });
    await processWhatsAppRawMessage(sock as never, rsvpWaMessage(chatId, eventMsgId, MEMBER_1, wrongSecret) as never);

    expect(await db.listNativeEventRsvps(event.id)).toEqual([]);
    expect(processInboundMessage).not.toHaveBeenCalled();
  });

  it('still dispatches ordinary chat messages', async () => {
    const { processWhatsAppRawMessage } = await loadProcessor();

    await processWhatsAppRawMessage(sock as never, {
      key: { remoteJid: 'group@g.us', id: nextId('m'), participant: MEMBER_1, fromMe: false },
      message: { conversation: 'hello there' },
    } as never);

    expect(normalizeWhatsAppInboundMessage).toHaveBeenCalledTimes(1);
    expect(processInboundMessage).toHaveBeenCalledTimes(1);
  });

  // Create the event through the same (per-generation) db module instance
  // the processor under test uses.
  async function makeWhatsAppEventVia(db: typeof import('../src/utils/db.js'), chatId: string, platformRef: string) {
    return db.addNativeEvent({
      chatId,
      platform: 'whatsapp',
      name: 'Trivia Night',
      description: null,
      location: null,
      startAtMs: Date.now() + 86_400_000,
      endAtMs: null,
      platformRef,
      createdBy: 'test_owner@s.whatsapp.net',
    });
  }
});

// ── !event show RSVP display ────────────────────────────────────────

describe('!event show RSVP counts', () => {
  interface MockMessenger extends PlatformMessenger {
    createNativeEvent: ReturnType<typeof vi.fn>;
  }

  function makeMessenger(platform: string, extras: Partial<PlatformMessenger> = {}): MockMessenger {
    let refCounter = 0;
    return {
      platform,
      sendText: vi.fn(async () => undefined),
      sendTextWithRef: vi.fn(async () => ({ platform, chatId: 'x', id: 'y', ref: {} })),
      sendPoll: vi.fn(async () => undefined),
      sendDocument: vi.fn(async () => ({ platform, chatId: 'x', id: 'y', ref: {} })),
      sendAudio: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      createNativeEvent: vi.fn(async () => `ref-${++refCounter}`),
      updateNativeEvent: vi.fn(async () => `ref-${++refCounter}`),
      cancelNativeEvent: vi.fn(async () => undefined),
      ...extras,
    } as unknown as MockMessenger;
  }

  async function createEventVia(messenger: PlatformMessenger, chatId: string): Promise<number> {
    const reply = await handleNativeEventCommand('tomorrow 7pm | Trivia Night', {
      messenger,
      chatId,
      senderId: 'test_owner@s.whatsapp.net',
    });
    const match = reply.match(/#(\d+)/);
    if (!match) throw new Error(`no event id in reply: ${reply}`);
    return Number(match[1]);
  }

  it('appends Going/Maybe/Not going counts for WhatsApp events', async () => {
    const chatId = nextId('chat');
    const messenger = makeMessenger('whatsapp');
    const eventId = await createEventVia(messenger, chatId);

    await upsertNativeEventRsvp(eventId, MEMBER_1, 'going', 1000);
    await upsertNativeEventRsvp(eventId, MEMBER_2, 'going', 1000);
    await upsertNativeEventRsvp(eventId, '15550003333@s.whatsapp.net', 'maybe', 1000);

    const shown = await handleNativeEventCommand(`show ${eventId}`, { messenger, chatId, senderId: 'x' });
    expect(shown).toContain('🙋 Going 2 · Maybe 1 · Not going 0');
    // Counts only — responder JIDs must never be rendered to the group.
    expect(shown).not.toContain('15550001111');
    expect(shown).not.toContain(MEMBER_1);
  });

  it('shows zero counts for a WhatsApp event with no RSVPs yet', async () => {
    const chatId = nextId('chat');
    const messenger = makeMessenger('whatsapp');
    const eventId = await createEventVia(messenger, chatId);

    const shown = await handleNativeEventCommand(`show ${eventId}`, { messenger, chatId, senderId: 'x' });
    expect(shown).toContain('🙋 Going 0 · Maybe 0 · Not going 0');
  });

  it('shows the Discord interested-user count from the live API', async () => {
    const chatId = nextId('chan');
    const getNativeEventInterestCount = vi.fn(async () => 12);
    const messenger = makeMessenger('discord', { getNativeEventInterestCount });
    const eventId = await createEventVia(messenger, chatId);

    const shown = await handleNativeEventCommand(`show ${eventId}`, { messenger, chatId, senderId: 'x' });
    expect(shown).toContain('🙋 Interested: 12');
    expect(getNativeEventInterestCount).toHaveBeenCalledWith(chatId, expect.any(String));
  });

  it('degrades to showing the event without counts when the Discord API fails', async () => {
    const chatId = nextId('chan');
    const getNativeEventInterestCount = vi.fn(async () => {
      throw new Error('Discord API /guilds failed (500): boom');
    });
    const messenger = makeMessenger('discord', { getNativeEventInterestCount });
    const eventId = await createEventVia(messenger, chatId);

    const shown = await handleNativeEventCommand(`show ${eventId}`, { messenger, chatId, senderId: 'x' });
    expect(shown).toContain('📅');
    expect(shown).toContain('Trivia Night');
    expect(shown).not.toContain('Interested');
  });

  it('omits the RSVP line when the platform has no count capability', async () => {
    const chatId = nextId('chan');
    const messenger = makeMessenger('discord');
    const eventId = await createEventVia(messenger, chatId);

    const shown = await handleNativeEventCommand(`show ${eventId}`, { messenger, chatId, senderId: 'x' });
    expect(shown).toContain('Trivia Night');
    expect(shown).not.toContain('🙋');
  });
});
