process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { describe, expect, it, vi } from 'vitest';

import { handleRehearsalCommand } from '../src/features/rehearsals.js';
import type { NativeEventPayload, PlatformMessenger } from '../src/core/platform-messenger.js';
import {
  getNativeEventById,
  getRehearsalById,
  listUpcomingEventReminders,
  upsertNativeEventRsvp,
} from '../src/utils/db.js';

let chatCounter = 0;

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

function nextChatId(): string {
  chatCounter += 1;
  return `rehearsal-chat-${process.pid}-${chatCounter}`;
}

function makeHeldError(jobId: number): Error {
  const held = new Error(`WhatsApp outbound job #${jobId} held: paused`);
  held.name = 'WhatsAppOutboundHeldError';
  (held as unknown as { jobId: number }).jobId = jobId;
  return held;
}

interface MockMessenger extends PlatformMessenger {
  createNativeEvent: ReturnType<typeof vi.fn>;
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
    createNativeEvent: vi.fn(async () => `rref-${++refCounter}`),
    updateNativeEvent: vi.fn(async () => `rref-${++refCounter}`),
    cancelNativeEvent: vi.fn(async () => undefined),
  } as unknown as MockMessenger;
}

/** A schedule "when" string for tomorrow evening, in the command's format. */
function tomorrowWhen(): { when: string; scheduledAt: number } {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const when = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 19:30`;
  const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 19, 30, 0, 0);
  return { when, scheduledAt: Math.floor(at.getTime() / 1000) };
}

function rehearsalIdFrom(reply: string): number {
  const match = /#(\d+)/.exec(reply);
  expect(match).not.toBeNull();
  return Number(match?.[1]);
}

async function remindersFor(chatId: string) {
  return (await listUpcomingEventReminders(1000)).filter((r) => r.chatJid === chatId);
}

describe('!rehearsal native-event tie-in', () => {
  it('schedule creates and links a platform event WITHOUT adding an event_reminders row', async () => {
    const messenger = makeMessenger();
    const chatId = nextChatId();
    const { when, scheduledAt } = tomorrowWhen();

    const reply = await handleRehearsalCommand(
      `schedule when=${when} location=Studio A agenda=run the opener`,
      { senderId: '222', messenger, chatId },
    );

    expect(reply).toContain('✅ Added:');
    expect(reply).toContain('📅 Platform event created:');
    expect(reply).toContain('Band rehearsal');

    const rehearsal = await getRehearsalById(rehearsalIdFrom(reply));
    expect(rehearsal?.nativeEventId).not.toBeNull();

    expect(messenger.createNativeEvent).toHaveBeenCalledTimes(1);
    const [calledChat, payload] = messenger.createNativeEvent.mock.calls[0] as [string, NativeEventPayload];
    expect(calledChat).toBe(chatId);
    expect(payload).toMatchObject({
      name: 'Band rehearsal',
      description: 'run the opener',
      location: 'Studio A',
      startAtMs: scheduledAt * 1000,
      endAtMs: scheduledAt * 1000 + TWO_HOURS_MS,
    });

    const event = await getNativeEventById(rehearsal?.nativeEventId as number);
    expect(event).toMatchObject({
      chatId,
      platform: 'discord',
      name: 'Band rehearsal',
      description: 'run the opener',
      location: 'Studio A',
      startAtMs: scheduledAt * 1000,
      status: 'scheduled',
      createdBy: '222',
    });

    // The load-bearing pin: rehearsals have their OWN reminder poller, so
    // the linked native event must NOT create an event_reminders row —
    // otherwise the band gets double pings.
    expect(event?.reminderId).toBeNull();
    expect(await remindersFor(chatId)).toHaveLength(0);
  });

  it('schedule without the capability behaves exactly as before', async () => {
    const messenger = makeMessenger();
    (messenger as Partial<PlatformMessenger>).createNativeEvent = undefined;
    const chatId = nextChatId();
    const { when } = tomorrowWhen();

    const reply = await handleRehearsalCommand(
      `schedule when=${when} location=Studio A`,
      { senderId: '222', messenger, chatId },
    );

    expect(reply).toMatch(/^✅ Added: #\d+ · /);
    expect(reply).not.toContain('\n');
    expect((await getRehearsalById(rehearsalIdFrom(reply)))?.nativeEventId).toBeNull();
  });

  it('schedule still succeeds with a warning when the platform create fails', async () => {
    const messenger = makeMessenger();
    messenger.createNativeEvent.mockRejectedValueOnce(new Error('Missing Manage Events permission'));
    const chatId = nextChatId();
    const { when } = tomorrowWhen();

    const reply = await handleRehearsalCommand(`schedule when=${when}`, { senderId: '222', messenger, chatId });

    expect(reply).toContain('✅ Added:');
    expect(reply).toContain('⚠️');
    expect(reply).toContain('platform event could not be created');
    expect((await getRehearsalById(rehearsalIdFrom(reply)))?.nativeEventId).toBeNull();
    expect(await remindersFor(chatId)).toHaveLength(0);
  });

  it('records a held WhatsApp create immediately and names the job — never "run it again"', async () => {
    const messenger = makeMessenger('whatsapp');
    messenger.createNativeEvent.mockRejectedValueOnce(makeHeldError(42));
    const chatId = nextChatId();
    const { when } = tomorrowWhen();

    const reply = await handleRehearsalCommand(`schedule when=${when}`, { senderId: '222', messenger, chatId });

    expect(reply).toContain('✅ Added:');
    expect(reply).toContain('job #42');
    expect(reply).toContain('!whatsapp release 42');
    expect(reply).not.toMatch(/run .* again/i);

    // The held job IS the event message: the event is recorded and linked now.
    const rehearsal = await getRehearsalById(rehearsalIdFrom(reply));
    expect(rehearsal?.nativeEventId).not.toBeNull();
    const event = await getNativeEventById(rehearsal?.nativeEventId as number);
    expect(event?.platformRef).toBe(JSON.stringify({ heldJobId: 42 }));
    expect(await remindersFor(chatId)).toHaveLength(0);
  });

  it('cancel cancels the linked platform event and the native row', async () => {
    const messenger = makeMessenger();
    const chatId = nextChatId();
    const { when } = tomorrowWhen();
    const ctx = { senderId: '222', messenger, chatId };

    const scheduled = await handleRehearsalCommand(`schedule when=${when} location=Studio A`, ctx);
    const id = rehearsalIdFrom(scheduled);
    const eventId = (await getRehearsalById(id))?.nativeEventId as number;
    const created = await getNativeEventById(eventId);

    const reply = await handleRehearsalCommand(`cancel ${id}`, ctx);

    expect(reply).toContain(`🗑️ Cancelled rehearsal #${id}.`);
    expect(reply).toContain(`📅 Cancelled the linked platform event #${eventId}.`);
    expect(messenger.cancelNativeEvent).toHaveBeenCalledWith(
      chatId,
      created?.platformRef,
      expect.objectContaining({ name: 'Band rehearsal' }),
    );
    expect((await getRehearsalById(id))?.status).toBe('cancelled');
    expect((await getNativeEventById(eventId))?.status).toBe('cancelled');
  });

  it('cancel still cancels the rehearsal (and records the event cancelled) when the platform cancel throws', async () => {
    const messenger = makeMessenger();
    const chatId = nextChatId();
    const { when } = tomorrowWhen();
    const ctx = { senderId: '222', messenger, chatId };

    const scheduled = await handleRehearsalCommand(`schedule when=${when}`, ctx);
    const id = rehearsalIdFrom(scheduled);
    const eventId = (await getRehearsalById(id))?.nativeEventId as number;
    messenger.cancelNativeEvent.mockRejectedValueOnce(new Error('discord 500'));

    const reply = await handleRehearsalCommand(`cancel ${id}`, ctx);

    expect(reply).toContain(`🗑️ Cancelled rehearsal #${id}.`);
    expect(reply).toContain('⚠️');
    expect((await getRehearsalById(id))?.status).toBe('cancelled');
    // Degraded, not blocked: the native row is still soft-cancelled here.
    expect((await getNativeEventById(eventId))?.status).toBe('cancelled');
  });

  it('show surfaces the event line and WhatsApp RSVP counts', async () => {
    const messenger = makeMessenger('whatsapp');
    const chatId = nextChatId();
    const { when } = tomorrowWhen();
    const ctx = { senderId: '222', messenger, chatId };

    const scheduled = await handleRehearsalCommand(`schedule when=${when} location=Studio A`, ctx);
    const id = rehearsalIdFrom(scheduled);
    const eventId = (await getRehearsalById(id))?.nativeEventId as number;

    await upsertNativeEventRsvp(eventId, '15550001111@s.whatsapp.net', 'going', Date.now());
    await upsertNativeEventRsvp(eventId, '15550002222@s.whatsapp.net', 'going', Date.now());
    await upsertNativeEventRsvp(eventId, '15550003333@s.whatsapp.net', 'maybe', Date.now());

    const reply = await handleRehearsalCommand(`show ${id}`, ctx);

    expect(reply).toContain(`📅 Event: #${eventId}`);
    expect(reply).toContain('Band rehearsal');
    expect(reply).toContain('🙋 Going 2 · Maybe 1 · Not going 0');
  });

  it('show for a rehearsal without a linked event stays unchanged', async () => {
    const messenger = makeMessenger();
    (messenger as Partial<PlatformMessenger>).createNativeEvent = undefined;
    const chatId = nextChatId();
    const { when } = tomorrowWhen();
    const ctx = { senderId: '222', messenger, chatId };

    const scheduled = await handleRehearsalCommand(`schedule when=${when}`, ctx);
    const reply = await handleRehearsalCommand(`show ${rehearsalIdFrom(scheduled)}`, ctx);

    expect(reply).toContain('🎸');
    expect(reply).not.toContain('📅 Event:');
  });
});
