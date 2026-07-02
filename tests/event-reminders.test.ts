import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

type Reminder = {
  id: number;
  chatJid: string;
  activity: string;
  location: string | null;
  eventAt: number;
  remindAt: number;
  createdBy: string;
  status: 'pending' | 'sent' | 'cancelled';
  createdAt: number;
};

const fixedNow = new Date(2026, 0, 10, 12, 0, 0, 0);

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 1,
    chatJid: 'events@g.us',
    activity: 'trivia night',
    location: 'Tavern',
    eventAt: Math.floor(new Date(2026, 0, 10, 19, 0, 0, 0).getTime() / 1000),
    remindAt: Math.floor(new Date(2026, 0, 10, 17, 0, 0, 0).getTime() / 1000),
    createdBy: 'sender@s.whatsapp.net',
    status: 'pending',
    createdAt: Math.floor(fixedNow.getTime() / 1000),
    ...overrides,
  };
}

describe('event reminder capture', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mockEventDeps(options: {
    enabled?: boolean;
    existing?: Reminder[];
    add?: ReturnType<typeof vi.fn>;
  } = {}) {
    const add = options.add ?? vi.fn(async (input: unknown) => ({ id: 10, ...(input as object) }));

    vi.doMock('../src/utils/config.js', () => ({
      config: {
        EVENT_REMINDERS_ENABLED: options.enabled ?? true,
        EVENT_REMINDER_LEAD_MINUTES: 120,
        GOOGLE_API_KEY: undefined,
        MBTA_API_KEY: undefined,
        LOG_LEVEL: 'silent',
      },
    }));
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock('../src/core/groups-config.js', () => ({
      getEnabledGroupJidByName: vi.fn(() => 'events@g.us'),
    }));
    vi.doMock('../src/ai/router.js', () => ({
      getAIResponse: vi.fn(async () => 'AI logistics'),
    }));
    vi.doMock('../src/utils/db.js', () => ({
      addEventReminder: add,
      listUpcomingEventReminders: vi.fn(async () => options.existing ?? []),
    }));

    return { add };
  }

  it('stores a reminder with computed event_at and remind_at after passive detection', async () => {
    const { add } = mockEventDeps();
    const { handleEventPassive } = await import('../src/features/events.js');

    const response = await handleEventPassive(
      "let's do trivia tonight at 7pm at Tavern",
      'sender@s.whatsapp.net',
      'events@g.us',
    );

    expect(response).toContain('AI logistics');
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[0]).toMatchObject({
      chatJid: 'events@g.us',
      activity: 'trivia night',
      location: 'Tavern',
      eventAt: Math.floor(new Date(2026, 0, 10, 19, 0, 0, 0).getTime() / 1000),
      remindAt: Math.floor(new Date(2026, 0, 10, 17, 0, 0, 0).getTime() / 1000),
      createdBy: 'sender@s.whatsapp.net',
    });
  });

  it('uses now plus 60 seconds when the lead time is already past', async () => {
    const { add } = mockEventDeps();
    const { handleEventPassive } = await import('../src/features/events.js');

    await handleEventPassive(
      "let's do trivia today at 1pm at Tavern",
      'sender@s.whatsapp.net',
      'events@g.us',
    );

    expect(add.mock.calls[0]?.[0]).toMatchObject({
      eventAt: Math.floor(new Date(2026, 0, 10, 13, 0, 0, 0).getTime() / 1000),
      remindAt: Math.floor(fixedNow.getTime() / 1000) + 60,
    });
  });

  it('dedups overlapping pending reminders in the same chat near the same event time', async () => {
    const existing = makeReminder({
      id: 33,
      activity: 'weekly trivia night',
      eventAt: Math.floor(new Date(2026, 0, 10, 19, 30, 0, 0).getTime() / 1000),
    });
    const { add } = mockEventDeps({ existing: [existing] });
    const { handleEventPassive } = await import('../src/features/events.js');

    await handleEventPassive(
      "let's do trivia tonight at 7pm at Tavern",
      'sender@s.whatsapp.net',
      'events@g.us',
    );

    expect(add).not.toHaveBeenCalled();
  });

  it('does not capture reminders when the feature flag is off', async () => {
    const { add } = mockEventDeps({ enabled: false });
    const { handleEventPassive } = await import('../src/features/events.js');

    await handleEventPassive(
      "let's do trivia tonight at 7pm at Tavern",
      'sender@s.whatsapp.net',
      'events@g.us',
    );

    expect(add).not.toHaveBeenCalled();
  });
});

describe('event reminder scheduler', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mockSchedulerDeps(options: {
    enabled?: boolean;
    due?: Reminder[];
    sendRejects?: boolean;
  } = {}) {
    const listPending = vi.fn(async () => options.due ?? []);
    const markSent = vi.fn(async () => true);
    const cancel = vi.fn(async () => true);

    vi.doMock('../src/utils/config.js', () => ({
      config: {
        EVENT_REMINDERS_ENABLED: options.enabled ?? true,
        LOG_LEVEL: 'silent',
      },
    }));
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock('../src/utils/db.js', () => ({
      listPendingEventReminders: listPending,
      markEventReminderSent: markSent,
      cancelEventReminder: cancel,
    }));

    const sendMessage = options.sendRejects
      ? vi.fn(async () => { throw new Error('send failed'); })
      : vi.fn(async () => undefined);

    return {
      listPending,
      markSent,
      cancel,
      sock: { sendMessage },
    };
  }

  it('sends due reminders and marks them sent after successful send', async () => {
    const { markSent, sock } = mockSchedulerDeps({ due: [makeReminder()] });
    const { getLifetimeCounters } = await import('../src/middleware/stats.js');
    const before = getLifetimeCounters().eventRemindersSentTotal;
    const { scheduleEventReminders } = await import('../src/platforms/whatsapp/event-reminders.js');

    const dispose = scheduleEventReminders(sock as never);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(sock.sendMessage).toHaveBeenCalledWith('events@g.us', {
      text: expect.stringContaining('Reminder: trivia night'),
    });
    expect(markSent).toHaveBeenCalledWith(1);
    expect(getLifetimeCounters().eventRemindersSentTotal).toBe(before + 1);
    dispose();
  });

  it('leaves failed sends pending, then cancels after three late failed polls', async () => {
    const overdue = makeReminder({
      remindAt: Math.floor(fixedNow.getTime() / 1000) - (31 * 60),
    });
    const { markSent, cancel, sock } = mockSchedulerDeps({ due: [overdue], sendRejects: true });
    const { scheduleEventReminders } = await import('../src/platforms/whatsapp/event-reminders.js');

    const dispose = scheduleEventReminders(sock as never);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(sock.sendMessage).toHaveBeenCalledTimes(3);
    expect(markSent).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(1);
    dispose();
  });

  it('disposer clears the pending timer', async () => {
    const { listPending, sock } = mockSchedulerDeps({ due: [makeReminder()] });
    const { scheduleEventReminders } = await import('../src/platforms/whatsapp/event-reminders.js');

    const dispose = scheduleEventReminders(sock as never);
    dispose();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(listPending).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  it('feature flag off returns a no-op disposer without arming a poll', async () => {
    const { listPending } = mockSchedulerDeps({ enabled: false, due: [makeReminder()] });
    const { scheduleEventReminders } = await import('../src/platforms/whatsapp/event-reminders.js');

    const dispose = scheduleEventReminders({ sendMessage: vi.fn() } as never);
    dispose();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(listPending).not.toHaveBeenCalled();
  });
});
