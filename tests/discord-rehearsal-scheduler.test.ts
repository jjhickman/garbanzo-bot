process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformMessenger } from '../src/core/platform-messenger.js';
import type { Rehearsal } from '../src/utils/db-types.js';

function makeRehearsal(overrides: Partial<Rehearsal> = {}): Rehearsal {
  return {
    id: 7,
    scheduledAt: Math.floor(new Date(2026, 6, 3, 19, 0, 0, 0).getTime() / 1000),
    location: 'The Garage',
    agenda: 'Run the new set',
    status: 'scheduled',
    reminderSent: false,
    createdBy: 'member-1',
    createdAt: Math.floor(new Date(2026, 6, 1, 12, 0, 0, 0).getTime() / 1000),
    updatedAt: Math.floor(new Date(2026, 6, 1, 12, 0, 0, 0).getTime() / 1000),
    ...overrides,
  };
}

const dueRehearsal = makeRehearsal();

function createMessenger(): PlatformMessenger {
  return {
    platform: 'discord',
    sendText: vi.fn<PlatformMessenger['sendText']>(async () => undefined),
    sendPoll: vi.fn<PlatformMessenger['sendPoll']>(async () => undefined),
    sendTextWithRef: vi.fn<PlatformMessenger['sendTextWithRef']>(async (chatId) => ({
      platform: 'discord',
      chatId,
      id: 'msg-1',
    })),
    sendDocument: vi.fn<PlatformMessenger['sendDocument']>(async (chatId) => ({
      platform: 'discord',
      chatId,
      id: 'doc-1',
    })),
    sendAudio: vi.fn<PlatformMessenger['sendAudio']>(async () => undefined),
    deleteMessage: vi.fn<PlatformMessenger['deleteMessage']>(async () => undefined),
  };
}

function mockSchedulerDeps(options: {
  eventRemindersEnabled?: boolean;
  practiceChannelId?: string;
  due?: Rehearsal[];
} = {}) {
  const listRehearsalsNeedingReminder = vi.fn(async () => options.due ?? []);
  const markRehearsalReminderSent = vi.fn(async () => true);
  const getRehearsalById = vi.fn(async () => null);
  const buildPracticeAgenda = vi.fn(async () => 'known practice agenda');
  const formatRehearsalLine = vi.fn((rehearsal: Rehearsal) => `#${rehearsal.id} formatted`);

  vi.doMock('../src/utils/config.js', () => ({
    config: {
      EVENT_REMINDERS_ENABLED: options.eventRemindersEnabled ?? true,
      DISCORD_PRACTICE_CHANNEL_ID: options.practiceChannelId,
      LOG_LEVEL: 'silent',
    },
  }));
  vi.doMock('../src/middleware/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));
  vi.doMock('../src/middleware/stats.js', () => ({
    snapshotAndReset: vi.fn(),
    recordEventReminderSent: vi.fn(),
  }));
  vi.doMock('../src/features/digest.js', () => ({
    formatDigest: vi.fn(async () => ''),
    archiveDailyDigest: vi.fn(async () => undefined),
  }));
  vi.doMock('../src/features/recap.js', () => ({
    buildWeeklyRecap: vi.fn(async () => ''),
  }));
  vi.doMock('../src/utils/db.js', () => ({
    listPendingEventReminders: vi.fn(async () => []),
    markEventReminderSent: vi.fn(async () => true),
    cancelEventReminder: vi.fn(async () => true),
    listRehearsalsNeedingReminder,
    markRehearsalReminderSent,
    getRehearsalById,
  }));
  vi.doMock('../src/features/rehearsals.js', () => ({
    formatRehearsalLine,
  }));
  vi.doMock('../src/features/practice-agenda.js', () => ({
    buildPracticeAgenda,
  }));

  return {
    listRehearsalsNeedingReminder,
    markRehearsalReminderSent,
    getRehearsalById,
    buildPracticeAgenda,
    formatRehearsalLine,
  };
}

describe('Discord rehearsal reminder scheduler', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends due rehearsal reminders to the target channel and marks them sent', async () => {
    vi.setSystemTime(new Date(2026, 6, 3, 17, 0, 0, 0));
    const { listRehearsalsNeedingReminder, markRehearsalReminderSent } = mockSchedulerDeps({
      due: [dueRehearsal],
    });
    const messenger = createMessenger();
    const { scheduleDiscordRehearsalReminders } = await import('../src/platforms/discord/schedulers.js');

    const dispose = scheduleDiscordRehearsalReminders(messenger, 'practice-channel');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(listRehearsalsNeedingReminder).toHaveBeenCalledWith(Math.floor(Date.now() / 1000));
    expect(messenger.sendText).toHaveBeenCalledWith(
      'practice-channel',
      expect.stringContaining('#7 formatted'),
    );
    expect(markRehearsalReminderSent).toHaveBeenCalledWith(7);
    dispose();
  });

  it('does not double-send once a rehearsal has been marked sent', async () => {
    vi.setSystemTime(new Date(2026, 6, 3, 17, 0, 0, 0));
    const { listRehearsalsNeedingReminder } = mockSchedulerDeps();
    listRehearsalsNeedingReminder
      .mockResolvedValueOnce([dueRehearsal])
      .mockResolvedValueOnce([]);
    const messenger = createMessenger();
    const { scheduleDiscordRehearsalReminders } = await import('../src/platforms/discord/schedulers.js');

    const dispose = scheduleDiscordRehearsalReminders(messenger, 'practice-channel');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(messenger.sendText).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(messenger.sendText).toHaveBeenCalledTimes(1);

    dispose();
  });

  it('a per-item send failure does not stop other reminders from being sent', async () => {
    vi.setSystemTime(new Date(2026, 6, 3, 17, 0, 0, 0));
    const failingRehearsal = makeRehearsal({ id: 8 });
    const { markRehearsalReminderSent } = mockSchedulerDeps({
      due: [failingRehearsal, dueRehearsal],
    });
    const messenger = createMessenger();
    (messenger.sendText as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const { scheduleDiscordRehearsalReminders } = await import('../src/platforms/discord/schedulers.js');

    const dispose = scheduleDiscordRehearsalReminders(messenger, 'practice-channel');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(messenger.sendText).toHaveBeenCalledTimes(2);
    expect(markRehearsalReminderSent).toHaveBeenCalledTimes(1);
    expect(markRehearsalReminderSent).toHaveBeenCalledWith(7);
    expect(markRehearsalReminderSent).not.toHaveBeenCalledWith(8);

    dispose();
  });

  it('disposer stops further polls', async () => {
    vi.setSystemTime(new Date(2026, 6, 3, 17, 0, 0, 0));
    const { listRehearsalsNeedingReminder } = mockSchedulerDeps({ due: [dueRehearsal] });
    const messenger = createMessenger();
    const { scheduleDiscordRehearsalReminders } = await import('../src/platforms/discord/schedulers.js');

    const dispose = scheduleDiscordRehearsalReminders(messenger, 'practice-channel');
    dispose();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(listRehearsalsNeedingReminder).not.toHaveBeenCalled();
    expect(messenger.sendText).not.toHaveBeenCalled();
  });

  it('does not arm when EVENT_REMINDERS_ENABLED is off', async () => {
    vi.setSystemTime(new Date(2026, 6, 3, 17, 0, 0, 0));
    const { listRehearsalsNeedingReminder } = mockSchedulerDeps({
      eventRemindersEnabled: false,
      due: [dueRehearsal],
    });
    const messenger = createMessenger();
    const { scheduleDiscordRehearsalReminders } = await import('../src/platforms/discord/schedulers.js');

    const dispose = scheduleDiscordRehearsalReminders(messenger, 'practice-channel');
    dispose();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(listRehearsalsNeedingReminder).not.toHaveBeenCalled();
    expect(messenger.sendText).not.toHaveBeenCalled();
  });
});

describe('Discord practice agenda scheduler', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a no-op when DISCORD_PRACTICE_CHANNEL_ID is not configured', async () => {
    vi.setSystemTime(new Date(2026, 6, 3, 17, 0, 0, 0));
    const { buildPracticeAgenda } = mockSchedulerDeps({ practiceChannelId: undefined });
    const messenger = createMessenger();
    const { scheduleDiscordPracticeAgenda } = await import('../src/platforms/discord/schedulers.js');

    const dispose = scheduleDiscordPracticeAgenda(messenger, 'practice-channel');
    await vi.advanceTimersByTimeAsync(8 * 24 * 60 * 60 * 1000);

    expect(buildPracticeAgenda).not.toHaveBeenCalled();
    expect(messenger.sendText).not.toHaveBeenCalled();
    dispose();
  });

  it('arms and posts the weekly practice agenda when DISCORD_PRACTICE_CHANNEL_ID is configured', async () => {
    vi.setSystemTime(new Date(2026, 6, 3, 17, 0, 0, 0));
    const { buildPracticeAgenda } = mockSchedulerDeps({ practiceChannelId: 'practice-channel' });
    const messenger = createMessenger();
    const { scheduleDiscordPracticeAgenda } = await import('../src/platforms/discord/schedulers.js');

    const dispose = scheduleDiscordPracticeAgenda(messenger, 'practice-channel');
    await vi.advanceTimersByTimeAsync(8 * 24 * 60 * 60 * 1000);

    expect(buildPracticeAgenda).toHaveBeenCalledTimes(1);
    expect(messenger.sendText).toHaveBeenCalledWith('practice-channel', 'known practice agenda');
    dispose();
  });
});
