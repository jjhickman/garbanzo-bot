process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';

import { describe, expect, it, vi } from 'vitest';

import { handleNativeEventCommand, parseEventWhen } from '../src/features/native-events.js';
import type { NativeEventPayload, PlatformMessenger } from '../src/core/platform-messenger.js';
import { config } from '../src/utils/config.js';
import {
  getNativeEventById,
  listPendingEventReminders,
  listUpcomingEventReminders,
  listUpcomingNativeEvents,
  markEventReminderSent,
} from '../src/utils/db.js';

let chatCounter = 0;

const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

/** Exactly what both platform pollers deliver: pending rows due by `bySeconds`. */
async function dueRemindersFor(chatJid: string, bySeconds: number = FAR_FUTURE_SECONDS) {
  return (await listPendingEventReminders(bySeconds)).filter((r) => r.chatJid === chatJid);
}

function makeHeldError(jobId: number): Error {
  const held = new Error(`WhatsApp outbound job #${jobId} held: paused`);
  held.name = 'WhatsAppOutboundHeldError';
  (held as unknown as { jobId: number }).jobId = jobId;
  return held;
}

function nextChatId(): string {
  chatCounter += 1;
  return `event-chat-${process.pid}-${chatCounter}`;
}

interface MockMessenger extends PlatformMessenger {
  createNativeEvent: ReturnType<typeof vi.fn>;
  updateNativeEvent: ReturnType<typeof vi.fn>;
  cancelNativeEvent: ReturnType<typeof vi.fn>;
}

function makeMessenger(platform: string = 'discord'): MockMessenger {
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
  } as unknown as MockMessenger;
}

describe('parseEventWhen', () => {
  const now = new Date(2026, 6, 20, 12, 0, 0, 0); // Mon Jul 20 2026, noon local

  it('parses relative day plus am/pm time', () => {
    const parsed = parseEventWhen('tomorrow 7pm', now);
    expect(parsed).toBe(new Date(2026, 6, 21, 19, 0, 0, 0).getTime());
  });

  it('parses a bare weekday with the default evening hour', () => {
    const parsed = parseEventWhen('friday', now);
    expect(parsed).toBe(new Date(2026, 6, 24, 19, 0, 0, 0).getTime());
  });

  it('parses numeric month/day with 24h time', () => {
    const parsed = parseEventWhen('8/2 19:30', now);
    expect(parsed).toBe(new Date(2026, 7, 2, 19, 30, 0, 0).getTime());
  });

  it('parses noon', () => {
    const parsed = parseEventWhen('tomorrow noon', now);
    expect(parsed).toBe(new Date(2026, 6, 21, 12, 0, 0, 0).getTime());
  });

  it('rejects past times', () => {
    expect(parseEventWhen('today 8am', now)).toBeNull();
  });

  it('rejects times more than 30 days out', () => {
    expect(parseEventWhen('12/25', now)).toBeNull();
  });

  it('rejects unparseable input', () => {
    expect(parseEventWhen('whenever works', now)).toBeNull();
    expect(parseEventWhen('', now)).toBeNull();
  });
});

describe('!event command', () => {
  it('shows usage for a bare or unknown command', async () => {
    const messenger = makeMessenger();
    const ctx = { messenger, chatId: nextChatId(), senderId: 'owner-1' };
    expect(await handleNativeEventCommand('!event', ctx)).toContain('Native Events');
    expect(await handleNativeEventCommand('bogus subcommand', ctx)).toContain('Native Events');
  });

  it('replies not-supported when the platform lacks the capability', async () => {
    const messenger = makeMessenger();
    (messenger as Partial<PlatformMessenger>).createNativeEvent = undefined;
    const reply = await handleNativeEventCommand('tomorrow 7pm | Trivia', {
      messenger,
      chatId: nextChatId(),
      senderId: 'owner-1',
    });
    expect(reply).toContain('not supported on this platform');
  });

  it('creates an event, stores the row, and records a reminder row', async () => {
    const messenger = makeMessenger();
    const chatId = nextChatId();
    const reply = await handleNativeEventCommand('tomorrow 7pm | Trivia Night | The Pub', {
      messenger,
      chatId,
      senderId: 'owner-1',
    });

    expect(reply).toMatch(/Created event #\d+/);
    expect(messenger.createNativeEvent).toHaveBeenCalledTimes(1);
    const [calledChat, payload] = messenger.createNativeEvent.mock.calls[0] as [string, NativeEventPayload];
    expect(calledChat).toBe(chatId);
    expect(payload.name).toBe('Trivia Night');
    expect(payload.location).toBe('The Pub');
    expect(payload.startAtMs).toBeGreaterThan(Date.now());

    const events = await listUpcomingNativeEvents(chatId, Date.now());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      chatId,
      platform: 'discord',
      name: 'Trivia Night',
      location: 'The Pub',
      startAtMs: payload.startAtMs,
      platformRef: 'ref-1',
      status: 'scheduled',
      createdBy: 'owner-1',
    });

    // EVENT_REMINDERS_ENABLED defaults to true, so a reminder row is created.
    const reminders = (await listUpcomingEventReminders(100)).filter((r) => r.chatJid === chatId);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].activity).toBe('Trivia Night');
    expect(reminders[0].eventAt).toBe(Math.floor(payload.startAtMs / 1000));

    // The event row links its reminder so move/cancel can keep it in sync.
    expect(events[0].reminderId).toBe(reminders[0].id);
  });

  it('rejects an unparseable or past when without touching the platform', async () => {
    const messenger = makeMessenger();
    const ctx = { messenger, chatId: nextChatId(), senderId: 'owner-1' };

    expect(await handleNativeEventCommand('someday | Party', ctx)).toContain("couldn't use");
    expect(await handleNativeEventCommand('today 12:00am | Party', ctx)).toContain("couldn't use");
    expect(messenger.createNativeEvent).not.toHaveBeenCalled();
  });

  it('rejects a create with a missing name', async () => {
    const messenger = makeMessenger();
    const reply = await handleNativeEventCommand('tomorrow 7pm |', {
      messenger,
      chatId: nextChatId(),
      senderId: 'owner-1',
    });
    expect(reply).toContain('Usage');
    expect(messenger.createNativeEvent).not.toHaveBeenCalled();
  });

  it('moves an event through the platform and tracks the new ref', async () => {
    const messenger = makeMessenger();
    const chatId = nextChatId();
    const ctx = { messenger, chatId, senderId: 'owner-1' };

    await handleNativeEventCommand('tomorrow 7pm | Practice', ctx);
    const created = (await listUpcomingNativeEvents(chatId, Date.now()))[0];

    const reply = await handleNativeEventCommand(`move ${created.id} tomorrow 8pm`, ctx);
    expect(reply).toContain('Updated');

    expect(messenger.updateNativeEvent).toHaveBeenCalledTimes(1);
    const [, oldRef, payload] = messenger.updateNativeEvent.mock.calls[0] as [string, string, NativeEventPayload];
    expect(oldRef).toBe(created.platformRef);
    expect(payload.name).toBe('Practice');

    const updated = await getNativeEventById(created.id);
    expect(updated?.startAtMs).toBe(payload.startAtMs);
    expect(updated?.startAtMs).not.toBe(created.startAtMs);
    expect(updated?.platformRef).not.toBe(created.platformRef);
  });

  it('move reschedules the linked reminder so the old time never fires', async () => {
    const messenger = makeMessenger();
    const chatId = nextChatId();
    const ctx = { messenger, chatId, senderId: 'owner-1' };

    await handleNativeEventCommand('tomorrow 7pm | Practice', ctx);
    const created = (await listUpcomingNativeEvents(chatId, Date.now()))[0];
    expect(created.reminderId).not.toBeNull();
    const oldRemindAt = (await dueRemindersFor(chatId))[0].remindAt;

    await handleNativeEventCommand(`move ${created.id} tomorrow 9pm`, ctx);
    const updated = await getNativeEventById(created.id);

    // Same reminder row, rescheduled in place to the new times.
    expect(updated?.reminderId).toBe(created.reminderId);
    const pending = await dueRemindersFor(chatId);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(created.reminderId);
    expect(pending[0].eventAt).toBe(Math.floor((updated?.startAtMs ?? 0) / 1000));
    expect(pending[0].remindAt).toBe(pending[0].eventAt - config.EVENT_REMINDER_LEAD_MINUTES * 60);

    // The pollers' due query at the OLD remind time returns nothing:
    // the stale reminder can never fire.
    expect(await dueRemindersFor(chatId, oldRemindAt)).toHaveLength(0);
  });

  it('creates a fresh pending reminder when moving an event whose reminder already fired', async () => {
    const messenger = makeMessenger();
    const chatId = nextChatId();
    const ctx = { messenger, chatId, senderId: 'owner-1' };

    await handleNativeEventCommand('tomorrow 7pm | Practice', ctx);
    const created = (await listUpcomingNativeEvents(chatId, Date.now()))[0];
    expect(created.reminderId).not.toBeNull();
    await markEventReminderSent(created.reminderId as number);

    await handleNativeEventCommand(`move ${created.id} tomorrow 9pm`, ctx);
    const updated = await getNativeEventById(created.id);

    // A fired reminder stays fired; the move links a NEW pending row.
    expect(updated?.reminderId).not.toBeNull();
    expect(updated?.reminderId).not.toBe(created.reminderId);
    const pending = await dueRemindersFor(chatId);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(updated?.reminderId);
    expect(pending[0].eventAt).toBe(Math.floor((updated?.startAtMs ?? 0) / 1000));
  });

  it('renames an event through the platform', async () => {
    const messenger = makeMessenger();
    const chatId = nextChatId();
    const ctx = { messenger, chatId, senderId: 'owner-1' };

    await handleNativeEventCommand('tomorrow 7pm | Old Name', ctx);
    const created = (await listUpcomingNativeEvents(chatId, Date.now()))[0];

    const reply = await handleNativeEventCommand(`rename ${created.id} New Name`, ctx);
    expect(reply).toContain('New Name');

    const [, , payload] = messenger.updateNativeEvent.mock.calls[0] as [string, string, NativeEventPayload];
    expect(payload.name).toBe('New Name');
    expect((await getNativeEventById(created.id))?.name).toBe('New Name');

    // The linked reminder text follows the rename.
    const pending = await dueRemindersFor(chatId);
    expect(pending).toHaveLength(1);
    expect(pending[0].activity).toBe('New Name');
  });

  it('cancels an event through the platform and blocks further edits', async () => {
    const messenger = makeMessenger();
    const chatId = nextChatId();
    const ctx = { messenger, chatId, senderId: 'owner-1' };

    await handleNativeEventCommand('tomorrow 7pm | Doomed', ctx);
    const created = (await listUpcomingNativeEvents(chatId, Date.now()))[0];

    const reply = await handleNativeEventCommand(`cancel ${created.id}`, ctx);
    expect(reply).toContain('Cancelled');
    expect(messenger.cancelNativeEvent).toHaveBeenCalledWith(
      chatId,
      created.platformRef,
      expect.objectContaining({ name: 'Doomed' }),
    );

    expect((await getNativeEventById(created.id))?.status).toBe('cancelled');
    expect(await listUpcomingNativeEvents(chatId, Date.now())).toHaveLength(0);

    // The linked reminder is cancelled too: the pollers' due query
    // (status = 'pending' AND remind_at <= now) can never return it.
    expect(created.reminderId).not.toBeNull();
    expect(await dueRemindersFor(chatId)).toHaveLength(0);

    const moveReply = await handleNativeEventCommand(`move ${created.id} tomorrow 9pm`, ctx);
    expect(moveReply).toContain('already cancelled');
  });

  it('treats ids from other chats or platforms as unknown', async () => {
    const messenger = makeMessenger();
    const chatId = nextChatId();
    await handleNativeEventCommand('tomorrow 7pm | Private', { messenger, chatId, senderId: 'owner-1' });
    const created = (await listUpcomingNativeEvents(chatId, Date.now()))[0];

    const otherChat = await handleNativeEventCommand(`show ${created.id}`, {
      messenger,
      chatId: nextChatId(),
      senderId: 'owner-1',
    });
    expect(otherChat).toContain('No event found');

    expect(await handleNativeEventCommand('show 999999', { messenger, chatId, senderId: 'owner-1' }))
      .toContain('No event found');
    expect(await handleNativeEventCommand('show abc', { messenger, chatId, senderId: 'owner-1' }))
      .toContain('event id');
  });

  it('records a held WhatsApp create immediately: the held job IS the event message', async () => {
    const messenger = makeMessenger('whatsapp');
    messenger.createNativeEvent.mockRejectedValueOnce(makeHeldError(42));

    const chatId = nextChatId();
    const reply = await handleNativeEventCommand('tomorrow 7pm | Meetup', {
      messenger,
      chatId,
      senderId: 'owner-1',
    });

    expect(reply).toContain('queued by the WhatsApp safety layer');
    expect(reply).toContain('job #42');
    expect(reply).toContain('!whatsapp release 42');
    expect(reply).not.toContain("Couldn't create");
    // Never instruct re-running: that would double-send on release.
    expect(reply).not.toMatch(/run the command again/i);
    expect(reply).not.toMatch(/again/i);

    // The event row is written with the held job as its platform ref.
    const events = await listUpcomingNativeEvents(chatId, Date.now());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: 'Meetup', status: 'scheduled' });
    expect(JSON.parse(events[0].platformRef)).toEqual({ heldJobId: 42 });

    // The reminder row is created and linked as on a normal create.
    const pending = await dueRemindersFor(chatId);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(events[0].reminderId);
    expect(pending[0].activity).toBe('Meetup');
  });

  it('applies a held WhatsApp move to the DB and reminder with a single send attempt', async () => {
    const messenger = makeMessenger('whatsapp');
    const chatId = nextChatId();
    const ctx = { messenger, chatId, senderId: 'owner-1' };

    await handleNativeEventCommand('tomorrow 7pm | Meetup', ctx);
    const created = (await listUpcomingNativeEvents(chatId, Date.now()))[0];

    messenger.updateNativeEvent.mockRejectedValueOnce(makeHeldError(7));
    const reply = await handleNativeEventCommand(`move ${created.id} tomorrow 9pm`, ctx);

    expect(reply).toContain('queued by the WhatsApp safety layer');
    expect(reply).toContain('job #7');
    expect(reply).toContain('!whatsapp release 7');
    expect(reply).not.toMatch(/run the command again/i);
    expect(reply).not.toMatch(/again/i);

    // Exactly one send attempt: the held replacement message posts on release.
    expect(messenger.updateNativeEvent).toHaveBeenCalledTimes(1);
    const [, , payload] = messenger.updateNativeEvent.mock.calls[0] as [string, string, NativeEventPayload];

    // The DB update applied anyway, keeping the prior ref, and the linked
    // reminder moved with it.
    const updated = await getNativeEventById(created.id);
    expect(updated?.startAtMs).toBe(payload.startAtMs);
    expect(updated?.platformRef).toBe(created.platformRef);
    const pending = await dueRemindersFor(chatId);
    expect(pending).toHaveLength(1);
    expect(pending[0].eventAt).toBe(Math.floor(payload.startAtMs / 1000));
  });

  it('applies a held WhatsApp cancel to the DB and cancels the reminder', async () => {
    const messenger = makeMessenger('whatsapp');
    const chatId = nextChatId();
    const ctx = { messenger, chatId, senderId: 'owner-1' };

    await handleNativeEventCommand('tomorrow 7pm | Doomed', ctx);
    const created = (await listUpcomingNativeEvents(chatId, Date.now()))[0];

    messenger.cancelNativeEvent.mockRejectedValueOnce(makeHeldError(9));
    const reply = await handleNativeEventCommand(`cancel ${created.id}`, ctx);

    expect(reply).toContain('queued by the WhatsApp safety layer');
    expect(reply).toContain('job #9');
    expect(reply).toContain('!whatsapp release 9');
    expect(reply).not.toMatch(/run the command again/i);
    expect(reply).not.toMatch(/again/i);

    expect((await getNativeEventById(created.id))?.status).toBe('cancelled');
    expect(await dueRemindersFor(chatId)).toHaveLength(0);
  });

  it('rejects names over 100 characters before any platform call', async () => {
    const messenger = makeMessenger();
    const chatId = nextChatId();
    const ctx = { messenger, chatId, senderId: 'owner-1' };
    const longName = 'x'.repeat(101);

    const createReply = await handleNativeEventCommand(`tomorrow 7pm | ${longName}`, ctx);
    expect(createReply).toContain('100 characters');
    expect(messenger.createNativeEvent).not.toHaveBeenCalled();

    await handleNativeEventCommand('tomorrow 7pm | Fine Name', ctx);
    const created = (await listUpcomingNativeEvents(chatId, Date.now()))[0];
    const renameReply = await handleNativeEventCommand(`rename ${created.id} ${longName}`, ctx);
    expect(renameReply).toContain('100 characters');
    expect(messenger.updateNativeEvent).not.toHaveBeenCalled();
    expect((await getNativeEventById(created.id))?.name).toBe('Fine Name');
  });

  it('rejects locations over 1000 characters before any platform call', async () => {
    const messenger = makeMessenger();
    const ctx = { messenger, chatId: nextChatId(), senderId: 'owner-1' };

    const reply = await handleNativeEventCommand(`tomorrow 7pm | Party | ${'y'.repeat(1001)}`, ctx);
    expect(reply).toContain('1000 characters');
    expect(messenger.createNativeEvent).not.toHaveBeenCalled();
  });

  it('surfaces other platform errors as a friendly failure', async () => {
    const messenger = makeMessenger();
    messenger.createNativeEvent.mockRejectedValueOnce(
      new Error('I need the Manage Events permission in this server to manage scheduled events.'),
    );

    const reply = await handleNativeEventCommand('tomorrow 7pm | Meetup', {
      messenger,
      chatId: nextChatId(),
      senderId: 'owner-1',
    });
    expect(reply).toContain('Manage Events');
  });

  it('lists upcoming events for the chat compactly', async () => {
    const messenger = makeMessenger();
    const chatId = nextChatId();
    const ctx = { messenger, chatId, senderId: 'owner-1' };

    expect(await handleNativeEventCommand('list', ctx)).toContain('No upcoming events');

    await handleNativeEventCommand('tomorrow 7pm | First', ctx);
    await handleNativeEventCommand('tomorrow 9pm | Second | Someplace', ctx);

    const reply = await handleNativeEventCommand('list', ctx);
    expect(reply).toContain('Upcoming Events');
    expect(reply).toContain('First');
    expect(reply).toContain('Second · Someplace');
  });
});
