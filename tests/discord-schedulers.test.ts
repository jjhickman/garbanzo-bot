process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformMessenger } from '../src/core/platform-messenger.js';
import type { EventReminder } from '../src/utils/db-types.js';

const dailyStats = {
  date: '2026-07-03',
  groups: new Map(),
  ownerDMs: 0,
  costs: [],
  totalCost: 0,
  vectorUpsertsOk: 0,
  vectorUpsertFailures: 0,
  vectorSearchesOk: 0,
  vectorSearchFailures: 0,
};

const dueReminder: EventReminder = {
  id: 42,
  chatJid: 'discord-events-channel',
  activity: 'trivia night',
  location: 'Tavern',
  eventAt: Math.floor(new Date(2026, 6, 3, 19, 0, 0, 0).getTime() / 1000),
  remindAt: Math.floor(new Date(2026, 6, 3, 17, 0, 0, 0).getTime() / 1000),
  createdBy: 'member-1',
  status: 'pending',
  createdAt: Math.floor(new Date(2026, 6, 3, 12, 0, 0, 0).getTime() / 1000),
};

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
  weeklyRecapEnabled?: boolean;
  eventRemindersEnabled?: boolean;
  due?: EventReminder[];
} = {}) {
  const snapshotAndReset = vi.fn(() => dailyStats);
  const formatDigest = vi.fn(async () => 'known daily digest');
  const archiveDailyDigest = vi.fn(async () => undefined);
  const buildWeeklyRecap = vi.fn(async () => 'known weekly recap');
  const listPendingEventReminders = vi.fn(async () => options.due ?? []);
  const markEventReminderSent = vi.fn(async () => true);
  const cancelEventReminder = vi.fn(async () => true);
  const recordEventReminderSent = vi.fn();

  vi.doMock('../src/utils/config.js', () => ({
    config: {
      WEEKLY_RECAP_ENABLED: options.weeklyRecapEnabled ?? true,
      EVENT_REMINDERS_ENABLED: options.eventRemindersEnabled ?? true,
      LOG_LEVEL: 'silent',
    },
  }));
  vi.doMock('../src/middleware/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));
  vi.doMock('../src/middleware/stats.js', () => ({
    snapshotAndReset,
    recordEventReminderSent,
  }));
  vi.doMock('../src/features/digest.js', () => ({
    formatDigest,
    archiveDailyDigest,
  }));
  vi.doMock('../src/features/recap.js', () => ({
    buildWeeklyRecap,
  }));
  vi.doMock('../src/utils/db.js', () => ({
    listPendingEventReminders,
    markEventReminderSent,
    cancelEventReminder,
  }));

  return {
    archiveDailyDigest,
    buildWeeklyRecap,
    formatDigest,
    listPendingEventReminders,
    markEventReminderSent,
    recordEventReminderSent,
    snapshotAndReset,
  };
}

describe('Discord scheduler binders', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the daily digest to the configured Discord target channel at 9 PM', async () => {
    vi.setSystemTime(new Date(2026, 6, 3, 20, 59, 0, 0));
    const { formatDigest, snapshotAndReset } = mockSchedulerDeps();
    const messenger = createMessenger();
    const { scheduleDiscordDigest } = await import('../src/platforms/discord/schedulers.js');

    const dispose = scheduleDiscordDigest(messenger, 'digest-channel');
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(snapshotAndReset).toHaveBeenCalledTimes(1);
    expect(formatDigest).toHaveBeenCalledWith(dailyStats);
    expect(messenger.sendText).toHaveBeenCalledWith('digest-channel', 'known daily digest');
    dispose();
  });

  it('daily digest disposer clears the pending timer', async () => {
    vi.setSystemTime(new Date(2026, 6, 3, 20, 59, 0, 0));
    mockSchedulerDeps();
    const messenger = createMessenger();
    const { scheduleDiscordDigest } = await import('../src/platforms/discord/schedulers.js');

    const dispose = scheduleDiscordDigest(messenger, 'digest-channel');
    dispose();
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(messenger.sendText).not.toHaveBeenCalled();
  });

  it('sends the weekly recap to the configured Discord target channel on Sunday at 6 PM', async () => {
    vi.setSystemTime(new Date(2026, 6, 5, 17, 59, 0, 0));
    const { buildWeeklyRecap } = mockSchedulerDeps();
    const messenger = createMessenger();
    const { scheduleDiscordWeeklyRecap } = await import('../src/platforms/discord/schedulers.js');

    const dispose = scheduleDiscordWeeklyRecap(messenger, 'recap-channel');
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(buildWeeklyRecap).toHaveBeenCalledTimes(1);
    expect(messenger.sendText).toHaveBeenCalledWith('recap-channel', 'known weekly recap');
    dispose();
  });

  it('weekly recap disposer clears the pending timer', async () => {
    vi.setSystemTime(new Date(2026, 6, 5, 17, 59, 0, 0));
    mockSchedulerDeps();
    const messenger = createMessenger();
    const { scheduleDiscordWeeklyRecap } = await import('../src/platforms/discord/schedulers.js');

    const dispose = scheduleDiscordWeeklyRecap(messenger, 'recap-channel');
    dispose();
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(messenger.sendText).not.toHaveBeenCalled();
  });

  it('does not arm weekly recap when the feature flag is disabled', async () => {
    vi.setSystemTime(new Date(2026, 6, 5, 17, 59, 0, 0));
    const { buildWeeklyRecap } = mockSchedulerDeps({ weeklyRecapEnabled: false });
    const messenger = createMessenger();
    const { scheduleDiscordWeeklyRecap } = await import('../src/platforms/discord/schedulers.js');

    const dispose = scheduleDiscordWeeklyRecap(messenger, 'recap-channel');
    dispose();
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(buildWeeklyRecap).not.toHaveBeenCalled();
    expect(messenger.sendText).not.toHaveBeenCalled();
  });

  it('sends due event reminders to their chat id and marks them sent', async () => {
    vi.setSystemTime(new Date(2026, 6, 3, 17, 0, 0, 0));
    const { listPendingEventReminders, markEventReminderSent } = mockSchedulerDeps({
      due: [dueReminder],
    });
    const messenger = createMessenger();
    const { scheduleDiscordEventReminders } = await import('../src/platforms/discord/schedulers.js');

    const dispose = scheduleDiscordEventReminders(messenger);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(listPendingEventReminders).toHaveBeenCalledWith(Math.floor(Date.now() / 1000));
    expect(messenger.sendText).toHaveBeenCalledWith(
      'discord-events-channel',
      expect.stringContaining('Reminder: trivia night'),
    );
    expect(markEventReminderSent).toHaveBeenCalledWith(42);
    dispose();
  });

  it('event reminder disposer clears the pending poll timer', async () => {
    vi.setSystemTime(new Date(2026, 6, 3, 17, 0, 0, 0));
    const { listPendingEventReminders } = mockSchedulerDeps({ due: [dueReminder] });
    const messenger = createMessenger();
    const { scheduleDiscordEventReminders } = await import('../src/platforms/discord/schedulers.js');

    const dispose = scheduleDiscordEventReminders(messenger);
    dispose();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(listPendingEventReminders).not.toHaveBeenCalled();
    expect(messenger.sendText).not.toHaveBeenCalled();
  });

  it('does not arm event reminders when the feature flag is disabled', async () => {
    vi.setSystemTime(new Date(2026, 6, 3, 17, 0, 0, 0));
    const { listPendingEventReminders } = mockSchedulerDeps({
      eventRemindersEnabled: false,
      due: [dueReminder],
    });
    const messenger = createMessenger();
    const { scheduleDiscordEventReminders } = await import('../src/platforms/discord/schedulers.js');

    const dispose = scheduleDiscordEventReminders(messenger);
    dispose();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(listPendingEventReminders).not.toHaveBeenCalled();
    expect(messenger.sendText).not.toHaveBeenCalled();
  });
});
