process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rehearsal } from '../src/utils/db-types.js';

// Postgres-mode guard: the facade probe reports no native-event persistence
// (as the postgres backend does), so feature code must never make the live
// platform call — a created Discord/WhatsApp event whose row insert then
// throws would be orphaned (no link, cancel could never sync it).
const dbMocks = vi.hoisted(() => ({
  supportsNativeEvents: vi.fn(() => false),
  addRehearsal: vi.fn(),
  getRehearsalById: vi.fn(),
  listUpcomingRehearsals: vi.fn(),
  updateRehearsal: vi.fn(),
  cancelRehearsal: vi.fn(),
  listAvailability: vi.fn(),
  addNativeEvent: vi.fn(),
  getNativeEventById: vi.fn(),
  listUpcomingNativeEvents: vi.fn(),
  updateNativeEvent: vi.fn(),
  addEventReminder: vi.fn(),
  cancelEventReminder: vi.fn(),
  rescheduleEventReminder: vi.fn(),
  renameEventReminder: vi.fn(),
  countNativeEventRsvps: vi.fn(),
}));

vi.mock('../src/utils/db.js', () => dbMocks);

import { handleNativeEventCommand } from '../src/features/native-events.js';
import { handleRehearsalCommand } from '../src/features/rehearsals.js';
import type { PlatformMessenger } from '../src/core/platform-messenger.js';

interface MockMessenger extends PlatformMessenger {
  createNativeEvent: ReturnType<typeof vi.fn>;
  cancelNativeEvent: ReturnType<typeof vi.fn>;
}

function makeMessenger(platform: string = 'discord'): MockMessenger {
  return {
    platform,
    sendText: vi.fn(async () => undefined),
    sendTextWithRef: vi.fn(async () => ({ platform, chatId: 'x', id: 'y', ref: {} })),
    sendPoll: vi.fn(async () => undefined),
    sendDocument: vi.fn(async () => ({ platform, chatId: 'x', id: 'y', ref: {} })),
    sendAudio: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    createNativeEvent: vi.fn(async () => 'ref-1'),
    updateNativeEvent: vi.fn(async () => 'ref-2'),
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

function makeRehearsal(overrides: Partial<Rehearsal> = {}): Rehearsal {
  return {
    id: 3,
    scheduledAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    location: 'Studio A',
    agenda: 'run the opener',
    status: 'scheduled',
    reminderSent: false,
    createdBy: '222',
    createdAt: 0,
    updatedAt: 0,
    nativeEventId: null,
    ...overrides,
  };
}

describe('native events on a backend without native-event persistence (postgres mode)', () => {
  beforeEach(() => {
    for (const mock of Object.values(dbMocks)) mock.mockReset();
    dbMocks.supportsNativeEvents.mockReturnValue(false);
  });

  it('rehearsal schedule stays pre-tie-in: no platform call, no event line, no link write', async () => {
    const { when, scheduledAt } = tomorrowWhen();
    dbMocks.addRehearsal.mockResolvedValueOnce(makeRehearsal({ scheduledAt }));
    const messenger = makeMessenger();

    const reply = await handleRehearsalCommand(
      `schedule when=${when} location=Studio A agenda=run the opener`,
      { senderId: '222', messenger, chatId: 'band-chat' },
    );

    // The rehearsal itself is saved and confirmed as a single line — exactly
    // the pre-tie-in reply, with no event line appended.
    expect(dbMocks.addRehearsal).toHaveBeenCalledTimes(1);
    expect(reply).toMatch(/^✅ Added: #\d+ · /);
    expect(reply).not.toContain('\n');
    expect(reply).not.toContain('📅');

    // The load-bearing pin: NO live platform event, NO row insert, NO link.
    expect(messenger.createNativeEvent).not.toHaveBeenCalled();
    expect(dbMocks.addNativeEvent).not.toHaveBeenCalled();
    expect(dbMocks.updateRehearsal).not.toHaveBeenCalled();
  });

  it('!event create replies with a clear backend message BEFORE any platform call', async () => {
    const messenger = makeMessenger();

    const reply = await handleNativeEventCommand('tomorrow 7pm | Trivia | The Pub', {
      messenger,
      chatId: 'event-chat',
      senderId: 'owner-1',
    });

    expect(reply).toContain('sqlite');
    expect(reply).toContain('backend');
    // Guarded before the platform call: nothing went live, nothing orphaned.
    expect(messenger.createNativeEvent).not.toHaveBeenCalled();
    expect(dbMocks.addNativeEvent).not.toHaveBeenCalled();
  });

  it('!event subcommands get the same friendly reply instead of a backend throw', async () => {
    const messenger = makeMessenger();
    const ctx = { messenger, chatId: 'event-chat', senderId: 'owner-1' };

    for (const command of ['list', 'show 3', 'cancel 3']) {
      const reply = await handleNativeEventCommand(command, ctx);
      expect(reply).toContain('sqlite');
    }
    expect(dbMocks.listUpcomingNativeEvents).not.toHaveBeenCalled();
    expect(dbMocks.getNativeEventById).not.toHaveBeenCalled();
  });

  it('everything passes through unchanged when the probe reports support', async () => {
    dbMocks.supportsNativeEvents.mockReturnValue(true);
    const { when, scheduledAt } = tomorrowWhen();
    const rehearsal = makeRehearsal({ scheduledAt });
    dbMocks.addRehearsal.mockResolvedValueOnce(rehearsal);
    dbMocks.addNativeEvent.mockResolvedValueOnce({
      id: 9,
      chatId: 'band-chat',
      platform: 'discord',
      name: 'Band rehearsal',
      description: null,
      location: null,
      startAtMs: scheduledAt * 1000,
      endAtMs: null,
      platformRef: 'ref-1',
      status: 'scheduled',
      reminderId: null,
      createdBy: '222',
      createdAtMs: 0,
    });
    dbMocks.updateRehearsal.mockResolvedValueOnce({ ...rehearsal, nativeEventId: 9 });
    const messenger = makeMessenger();

    const reply = await handleRehearsalCommand(`schedule when=${when}`, {
      senderId: '222',
      messenger,
      chatId: 'band-chat',
    });

    expect(messenger.createNativeEvent).toHaveBeenCalledTimes(1);
    expect(reply).toContain('📅 Platform event created:');
  });
});
