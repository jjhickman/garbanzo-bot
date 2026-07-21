process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

/**
 * End-to-end `!event` and `!rehearsal` coverage on the announcement-message
 * platforms (Telegram, Matrix): the REAL adapters run against a mocked
 * transport, and the unchanged feature layer drives them through the
 * createNativeEvent/updateNativeEvent/cancelNativeEvent seam.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleNativeEventCommand } from '../src/features/native-events.js';
import { handleRehearsalCommand } from '../src/features/rehearsals.js';
import { createTelegramAdapter } from '../src/platforms/telegram/adapter.js';
import { createMatrixAdapter, type MatrixSendClient } from '../src/platforms/matrix/adapter.js';
import { getNativeEventById, getRehearsalById, listPendingEventReminders } from '../src/utils/db.js';

let chatCounter = 0;

const FAR_FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

/** All pending event_reminders rows for a chat (what a poller would ever deliver). */
async function pendingRemindersFor(chatJid: string) {
  return (await listPendingEventReminders(FAR_FUTURE_SECONDS)).filter((r) => r.chatJid === chatJid);
}

function nextChatId(prefix: string): string {
  chatCounter += 1;
  return `${prefix}-${process.pid}-${chatCounter}`;
}

function eventIdFrom(reply: string): number {
  const match = /#(\d+)/.exec(reply);
  expect(match).not.toBeNull();
  return Number(match?.[1]);
}

/** A schedule "when" string for tomorrow evening, in the rehearsal command's format. */
function tomorrowWhen(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 19:30`;
}

interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

function stubTelegramFetch(): TelegramCall[] {
  const calls: TelegramCall[] = [];
  let messageId = 500;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const method = url.split('/').pop() ?? '';
    calls.push({ method, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const result = method === 'sendMessage' ? { message_id: ++messageId } : true;
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) } as unknown as Response;
  }));
  return calls;
}

function createMatrixMock(): MatrixSendClient & { sendMessage: ReturnType<typeof vi.fn> } {
  let counter = 0;
  return {
    sendMessage: vi.fn(async () => `$evt-${++counter}`),
  } as MatrixSendClient & { sendMessage: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('!event round-trip on Telegram (announcement messages)', () => {
  it('create/move/show/cancel work end-to-end and edit the same message', async () => {
    const calls = stubTelegramFetch();
    const messenger = createTelegramAdapter('test-bot-token');
    const ctx = { messenger, chatId: nextChatId('tg-event'), senderId: 'owner-1' };

    const created = await handleNativeEventCommand('tomorrow 7pm | Band Practice | The Garage', ctx);
    expect(created).toContain('✅ Created event');
    const id = eventIdFrom(created);

    const row = await getNativeEventById(id);
    expect(row?.platform).toBe('telegram');
    const ref = JSON.parse(row?.platformRef ?? '{}') as { chatId?: string; messageId?: number };
    expect(ref.chatId).toBe(ctx.chatId);
    expect(typeof ref.messageId).toBe('number');

    // No reminder poller runs on Telegram, so despite EVENT_REMINDERS_ENABLED
    // defaulting true no event_reminders row is recorded (it could never fire).
    expect(row?.reminderId).toBeNull();
    expect(await pendingRemindersFor(ctx.chatId)).toHaveLength(0);

    const moved = await handleNativeEventCommand(`move ${id} tomorrow 8pm`, ctx);
    expect(moved).toContain('✅ Updated:');
    // A move must not conjure an undeliverable reminder row either.
    expect((await getNativeEventById(id))?.reminderId).toBeNull();
    expect(await pendingRemindersFor(ctx.chatId)).toHaveLength(0);
    // Ref unchanged: the update edited the same message instead of re-sending.
    expect((await getNativeEventById(id))?.platformRef).toBe(row?.platformRef);
    const edits = calls.filter((c) => c.method === 'editMessageText');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.body.message_id).toBe(ref.messageId);

    // show degrades gracefully: details without any RSVP/interest line.
    const shown = await handleNativeEventCommand(`show ${id}`, ctx);
    expect(shown).toContain('Band Practice');
    expect(shown).not.toContain('🙋');

    const cancelled = await handleNativeEventCommand(`cancel ${id}`, ctx);
    expect(cancelled).toContain(`🗑️ Cancelled event #${id}`);
    expect((await getNativeEventById(id))?.status).toBe('cancelled');
    const cancelEdit = calls.filter((c) => c.method === 'editMessageText')[1];
    expect(cancelEdit?.body.message_id).toBe(ref.messageId);
    expect(String(cancelEdit?.body.text)).toContain('CANCELLED');
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
  });

  it('move reposts the announcement and persists the NEW ref when the original was deleted', async () => {
    const calls: TelegramCall[] = [];
    let messageId = 700;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const method = url.split('/').pop() ?? '';
      calls.push({ method, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      if (method === 'editMessageText') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }),
        } as unknown as Response;
      }
      const result = method === 'sendMessage' ? { message_id: ++messageId } : true;
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) } as unknown as Response;
    }));
    const messenger = createTelegramAdapter('test-bot-token');
    const ctx = { messenger, chatId: nextChatId('tg-event'), senderId: 'owner-1' };

    const created = await handleNativeEventCommand('tomorrow 7pm | Band Practice', ctx);
    const id = eventIdFrom(created);
    const originalRef = (await getNativeEventById(id))?.platformRef;

    const moved = await handleNativeEventCommand(`move ${id} tomorrow 8pm`, ctx);
    expect(moved).toContain('✅ Updated:');

    // The repost's message id was persisted, so the event stays editable.
    const newRef = (await getNativeEventById(id))?.platformRef;
    expect(newRef).not.toBe(originalRef);
    expect(JSON.parse(newRef ?? '{}')).toEqual({ chatId: ctx.chatId, messageId: 702 });
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(2);
  });

  it('cancel still cancels the row when the announcement was deleted', async () => {
    let messageId = 800;
    const calls: TelegramCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const method = url.split('/').pop() ?? '';
      calls.push({ method, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      if (method === 'editMessageText') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }),
        } as unknown as Response;
      }
      const result = method === 'sendMessage' ? { message_id: ++messageId } : true;
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) } as unknown as Response;
    }));
    const messenger = createTelegramAdapter('test-bot-token');
    const ctx = { messenger, chatId: nextChatId('tg-event'), senderId: 'owner-1' };

    const created = await handleNativeEventCommand('tomorrow 7pm | Band Practice', ctx);
    const id = eventIdFrom(created);

    const cancelled = await handleNativeEventCommand(`cancel ${id}`, ctx);
    expect(cancelled).toContain(`🗑️ Cancelled event #${id}`);
    expect((await getNativeEventById(id))?.status).toBe('cancelled');
    // No repost of a cancellation for a message nobody can see.
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
  });

  it('a failed platform create degrades to the honest error reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was kicked' }),
    } as unknown as Response)));
    const messenger = createTelegramAdapter('test-bot-token');
    const ctx = { messenger, chatId: nextChatId('tg-event'), senderId: 'owner-1' };

    const reply = await handleNativeEventCommand('tomorrow 7pm | Practice', ctx);
    expect(reply).toContain("❌ Couldn't create the event");
  });
});

describe('!event round-trip on Matrix (announcement messages)', () => {
  it('create/move/show/cancel work end-to-end via m.replace edits', async () => {
    const client = createMatrixMock();
    const messenger = createMatrixAdapter(client);
    const ctx = { messenger, chatId: `!${nextChatId('mx-event')}:example.org`, senderId: '@owner:example.org' };

    const created = await handleNativeEventCommand('tomorrow 7pm | Band Practice | The Garage', ctx);
    expect(created).toContain('✅ Created event');
    const id = eventIdFrom(created);

    const row = await getNativeEventById(id);
    expect(row?.platform).toBe('matrix');
    expect(JSON.parse(row?.platformRef ?? '{}')).toEqual({ roomId: ctx.chatId, eventId: '$evt-1' });

    // No reminder poller runs on Matrix either — no undeliverable row.
    expect(row?.reminderId).toBeNull();
    expect(await pendingRemindersFor(ctx.chatId)).toHaveLength(0);

    const moved = await handleNativeEventCommand(`move ${id} tomorrow 8pm`, ctx);
    expect(moved).toContain('✅ Updated:');
    expect((await getNativeEventById(id))?.platformRef).toBe(row?.platformRef);
    const [, editContent] = client.sendMessage.mock.calls[1] as [string, Record<string, unknown>];
    expect(editContent['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: '$evt-1' });

    const shown = await handleNativeEventCommand(`show ${id}`, ctx);
    expect(shown).toContain('Band Practice');
    expect(shown).not.toContain('🙋');

    const cancelled = await handleNativeEventCommand(`cancel ${id}`, ctx);
    expect(cancelled).toContain(`🗑️ Cancelled event #${id}`);
    expect((await getNativeEventById(id))?.status).toBe('cancelled');
    const [, cancelContent] = client.sendMessage.mock.calls[2] as [string, Record<string, unknown>];
    expect(cancelContent['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: '$evt-1' });
    expect(String((cancelContent['m.new_content'] as Record<string, unknown>).body)).toContain('CANCELLED');
  });
});

describe('!rehearsal tie-in on the announcement platforms', () => {
  it('schedule creates and cancel syncs the linked event on Telegram', async () => {
    const calls = stubTelegramFetch();
    const messenger = createTelegramAdapter('test-bot-token');
    const ctx = { senderId: '222', messenger, chatId: nextChatId('tg-rehearsal') };

    const scheduled = await handleRehearsalCommand(`schedule when=${tomorrowWhen()} location=Studio A`, ctx);
    expect(scheduled).toContain('✅ Added:');
    expect(scheduled).toContain('📅 Platform event created:');

    const rehearsalId = eventIdFrom(scheduled);
    const nativeEventId = (await getRehearsalById(rehearsalId))?.nativeEventId as number;
    expect((await getNativeEventById(nativeEventId))?.platform).toBe('telegram');
    const announcement = calls.find((c) => c.method === 'sendMessage');
    expect(String(announcement?.body.text)).toContain('Band rehearsal');

    const cancelled = await handleRehearsalCommand(`cancel ${rehearsalId}`, ctx);
    expect(cancelled).toContain(`📅 Cancelled the linked platform event #${nativeEventId}.`);
    expect((await getNativeEventById(nativeEventId))?.status).toBe('cancelled');
    expect(String(calls.find((c) => c.method === 'editMessageText')?.body.text)).toContain('CANCELLED');
  });

  it('schedule creates and cancel syncs the linked event on Matrix', async () => {
    const client = createMatrixMock();
    const messenger = createMatrixAdapter(client);
    const ctx = { senderId: '@drummer:example.org', messenger, chatId: `!${nextChatId('mx-rehearsal')}:example.org` };

    const scheduled = await handleRehearsalCommand(`schedule when=${tomorrowWhen()} location=Studio A`, ctx);
    expect(scheduled).toContain('📅 Platform event created:');

    const rehearsalId = eventIdFrom(scheduled);
    const nativeEventId = (await getRehearsalById(rehearsalId))?.nativeEventId as number;
    expect((await getNativeEventById(nativeEventId))?.platform).toBe('matrix');

    const cancelled = await handleRehearsalCommand(`cancel ${rehearsalId}`, ctx);
    expect(cancelled).toContain(`📅 Cancelled the linked platform event #${nativeEventId}.`);
    const [, cancelContent] = client.sendMessage.mock.calls[1] as [string, Record<string, unknown>];
    expect(cancelContent['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: '$evt-1' });
  });
});
