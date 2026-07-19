process.env.MESSAGING_PLATFORM ??= 'telegram';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.TELEGRAM_OWNER_ID ??= '111';
process.env.TELEGRAM_BOT_TOKEN ??= 'test_tg_token';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mapTelegramMessageToPayload, type RawTelegramMessage } from '../src/platforms/telegram/client.js';

const BOT = { id: 999, username: 'GarbanzoBot' };

function baseMessage(overrides: Partial<RawTelegramMessage> = {}): RawTelegramMessage {
  return {
    message_id: 1,
    date: 1_735_689_600,
    chat: { id: -100123, type: 'group' },
    from: { id: 42, first_name: 'Ada', last_name: 'Lovelace' },
    text: 'hello there',
    ...overrides,
  };
}

describe('mapTelegramMessageToPayload — text mapping', () => {
  it('maps basic text fields', () => {
    const payload = mapTelegramMessageToPayload(baseMessage(), BOT);

    expect(payload).toMatchObject({
      messageId: '1',
      chatId: '-100123',
      isGroupChat: true,
      text: 'hello there',
      senderId: '42',
      senderName: 'Ada Lovelace',
      timestampMs: 1_735_689_600_000,
      fromSelf: false,
    });
  });

  it('builds senderName from first_name + last_name', () => {
    const payload = mapTelegramMessageToPayload(baseMessage({
      from: { id: 42, first_name: 'Ada', last_name: 'Lovelace' },
    }), BOT);
    expect(payload.senderName).toBe('Ada Lovelace');
  });

  it('falls back to username when first/last name are absent', () => {
    const payload = mapTelegramMessageToPayload(baseMessage({
      from: { id: 42, username: 'ada_l' },
    }), BOT);
    expect(payload.senderName).toBe('ada_l');
  });

  it('leaves senderName undefined when nothing is available', () => {
    const payload = mapTelegramMessageToPayload(baseMessage({ from: { id: 42 } }), BOT);
    expect(payload.senderName).toBeUndefined();
  });

  it('treats a private chat as not a group chat', () => {
    const payload = mapTelegramMessageToPayload(baseMessage({ chat: { id: 42, type: 'private' } }), BOT);
    expect(payload.isGroupChat).toBe(false);
  });
});

describe('mapTelegramMessageToPayload — reply-to mapping', () => {
  it('maps reply_to_message text into quotedText', () => {
    const payload = mapTelegramMessageToPayload(baseMessage({
      reply_to_message: {
        message_id: 0,
        date: 0,
        chat: { id: -100123, type: 'group' },
        from: { id: 42 },
        text: 'the original message',
      },
    }), BOT);

    expect(payload.quotedText).toBe('the original message');
  });

  it('marks the message as addressed to the bot when it replies to the bot', () => {
    const payload = mapTelegramMessageToPayload(baseMessage({
      reply_to_message: {
        message_id: 0,
        date: 0,
        chat: { id: -100123, type: 'group' },
        from: { id: BOT.id },
        text: 'bot said something',
      },
    }), BOT);

    expect(payload.mentionedIds).toContain(String(BOT.id));
  });

  it('marks the message as addressed to the bot on an @username mention', () => {
    const payload = mapTelegramMessageToPayload(baseMessage({ text: 'hey @GarbanzoBot help me' }), BOT);
    expect(payload.mentionedIds).toContain(String(BOT.id));
  });

  it('does not mark the message as addressed when there is no mention or reply', () => {
    const payload = mapTelegramMessageToPayload(baseMessage(), BOT);
    expect(payload.mentionedIds).toEqual([]);
  });
});

describe('mapTelegramMessageToPayload — voice mapping', () => {
  it('surfaces voice file id and mime type', () => {
    const payload = mapTelegramMessageToPayload(baseMessage({
      text: undefined,
      voice: { file_id: 'file-abc', file_unique_id: 'u1', duration: 5, mime_type: 'audio/ogg' },
    }), BOT);

    expect(payload.voice).toEqual({ fileId: 'file-abc', mimeType: 'audio/ogg' });
  });

  it('defaults mime type to audio/ogg when Telegram omits it', () => {
    const payload = mapTelegramMessageToPayload(baseMessage({
      text: undefined,
      voice: { file_id: 'file-abc', file_unique_id: 'u1', duration: 5 },
    }), BOT);

    expect(payload.voice?.mimeType).toBe('audio/ogg');
  });

  it('leaves voice undefined for a plain text message', () => {
    const payload = mapTelegramMessageToPayload(baseMessage(), BOT);
    expect(payload.voice).toBeUndefined();
  });
});

describe('mapTelegramMessageToPayload — media mapping', () => {
  it('surfaces the largest photo for conditional bridge download', () => {
    const payload = mapTelegramMessageToPayload(baseMessage({
      text: undefined,
      photo: [
        { file_id: 'small', file_unique_id: 'small-u', width: 90, height: 90, file_size: 100 },
        { file_id: 'large', file_unique_id: 'large-u', width: 1280, height: 720, file_size: 300 },
      ],
    }), BOT);

    expect(payload.media).toEqual({
      fileId: 'large',
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
      kind: 'image',
      size: 300,
    });
  });
});

describe('mapTelegramMessageToPayload — loop prevention (fromSelf)', () => {
  it('marks fromSelf true when the sender is the bot itself', () => {
    const payload = mapTelegramMessageToPayload(baseMessage({ from: { id: BOT.id, is_bot: true } }), BOT);
    expect(payload.fromSelf).toBe(true);
  });

  it('marks fromSelf false for any other sender, including other bots', () => {
    const payload = mapTelegramMessageToPayload(baseMessage({ from: { id: 555, is_bot: true } }), BOT);
    expect(payload.fromSelf).toBe(false);
  });
});

describe('Telegram client — end-to-end message handler wiring', () => {
  beforeEach(() => {
    delete process.env.BRIDGE_MEDIA_ENABLED;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function setup(options: {
    isChatEnabled?: (chatId: string) => boolean;
    botStartImpl?: (opts?: { onStart?: (info: { id: number; username?: string }) => void }) => Promise<void>;
  } = {}) {
    const sendText = vi.fn(async () => undefined);
    const createTelegramAdapter = vi.fn(() => ({
      platform: 'telegram' as const,
      sendText,
      sendTextWithRef: vi.fn(async (chatId: string) => ({ platform: 'telegram' as const, chatId, id: '1', ref: {} })),
      sendPoll: vi.fn(async () => undefined),
      sendDocument: vi.fn(async (chatId: string) => ({ platform: 'telegram' as const, chatId, id: '1', ref: {} })),
      sendAudio: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
    }));
    const processTelegramEvent = vi.fn(async () => undefined);
    const isTelegramChatEnabled = vi.fn(options.isChatEnabled ?? (() => true));
    const getTelegramChatName = vi.fn(() => undefined);
    const downloadTelegramVoice = vi.fn(async () => Buffer.from([9, 9, 9]));
    const downloadTelegramFile = vi.fn(async () => Buffer.from([7, 8, 9]));
    const markConnected = vi.fn();
    const markDisconnected = vi.fn();

    vi.doMock('../src/platforms/telegram/adapter.js', () => ({ createTelegramAdapter }));
    vi.doMock('../src/platforms/telegram/processor.js', () => ({ processTelegramEvent }));
    vi.doMock('../src/platforms/telegram/telegram-config.js', () => ({ isTelegramChatEnabled, getTelegramChatName }));
    vi.doMock('../src/platforms/telegram/telegram-voice.js', () => ({
      downloadTelegramFile,
      downloadTelegramVoice,
    }));
    vi.doMock('../src/middleware/health.js', () => ({ markConnected, markDisconnected }));

    const module = await import('../src/platforms/telegram/client.js');
    const bot = {
      handlers: new Map<string, (ctx: unknown) => Promise<void>>(),
      on: vi.fn((event: string, handler: (ctx: unknown) => Promise<void>) => {
        bot.handlers.set(event, handler);
      }),
      catch: vi.fn(),
      init: vi.fn(async () => undefined),
      start: vi.fn(options.botStartImpl ?? (async () => undefined)),
      stop: vi.fn(async () => undefined),
      botInfo: { id: BOT.id, username: BOT.username },
    };

    const client = module.createTelegramClient({
      token: 'super-secret-token-abc',
      ownerId: 'owner-chat',
      ownerUserId: '111',
      botFactory: () => bot,
    });

    return {
      client, bot, processTelegramEvent, sendText, isTelegramChatEnabled, downloadTelegramFile, downloadTelegramVoice,
      markConnected, markDisconnected,
    };
  }

  it('registers a message handler and resolves bot identity from init() before any update', async () => {
    const { client, bot } = await setup();
    await client.start();

    expect(bot.on).toHaveBeenCalledWith('message', expect.any(Function));
    expect(bot.init).toHaveBeenCalled();
  });

  it('dispatches a text message to processTelegramEvent', async () => {
    const { client, bot, processTelegramEvent } = await setup();
    await client.start();

    await bot.handlers.get('message')?.({
      update: {
        message: {
          message_id: 5,
          date: 1_735_689_600,
          chat: { id: -100123, type: 'group' },
          from: { id: 42, first_name: 'Ada' },
          text: 'hi bot',
        },
      },
      me: BOT,
    });

    expect(processTelegramEvent).toHaveBeenCalledTimes(1);
    const [, payload, env] = processTelegramEvent.mock.calls[0] as [unknown, Record<string, unknown>, Record<string, unknown>];
    expect(payload.chatId).toBe('-100123');
    expect(payload.senderId).toBe('42');
    expect(env.botUserId).toBe(String(BOT.id));
  });

  it('conditionally downloads a photo and threads its media buffer to the processor', async () => {
    process.env.BRIDGE_MEDIA_ENABLED = 'true';
    const { client, bot, processTelegramEvent, downloadTelegramFile } = await setup();
    await client.start();

    await bot.handlers.get('message')?.({
      update: {
        message: {
          message_id: 6,
          date: 1_735_689_600,
          chat: { id: -100123, type: 'group' },
          from: { id: 42, first_name: 'Ada' },
          caption: 'photo caption',
          photo: [{ file_id: 'photo-file', file_unique_id: 'photo-u', width: 640, height: 480 }],
        },
      },
      me: BOT,
    });

    expect(downloadTelegramFile).toHaveBeenCalledWith('super-secret-token-abc', 'photo-file', 8_388_608);
    const [, payload] = processTelegramEvent.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload.media).toMatchObject({
      contentType: 'image/jpeg',
      kind: 'image',
      buffer: Buffer.from([7, 8, 9]),
    });
  });

  it('does not download photo bytes when bridge media is disabled', async () => {
    const { client, bot, processTelegramEvent, downloadTelegramFile } = await setup();
    await client.start();

    await bot.handlers.get('message')?.({
      update: {
        message: {
          message_id: 7,
          date: 1_735_689_600,
          chat: { id: -100123, type: 'group' },
          from: { id: 42, first_name: 'Ada' },
          photo: [{ file_id: 'photo-file', file_unique_id: 'photo-u', width: 640, height: 480 }],
        },
      },
      me: BOT,
    });

    expect(downloadTelegramFile).not.toHaveBeenCalled();
    const [, payload] = processTelegramEvent.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload.media).toMatchObject({ contentType: 'image/jpeg', kind: 'image' });
    expect(payload.media).not.toHaveProperty('buffer');
  });

  it('drops the bot\'s own messages (fromSelf) without calling processTelegramEvent', async () => {
    const { client, bot, processTelegramEvent } = await setup();
    await client.start();

    await bot.handlers.get('message')?.({
      update: {
        message: {
          message_id: 6,
          date: 1_735_689_600,
          chat: { id: -100123, type: 'group' },
          from: { id: BOT.id, is_bot: true },
          text: 'a message the bot itself sent',
        },
      },
      me: BOT,
    });

    expect(processTelegramEvent).not.toHaveBeenCalled();
  });

  it('welcomes new chat members and skips the bot itself joining', async () => {
    const { client, bot, sendText, isTelegramChatEnabled } = await setup();
    await client.start();

    await bot.handlers.get('message')?.({
      update: {
        message: {
          message_id: 7,
          date: 1_735_689_600,
          chat: { id: -100123, type: 'group' },
          new_chat_members: [
            { id: 200, first_name: 'New', last_name: 'Member' },
            { id: BOT.id, is_bot: true }, // the bot itself being added — not welcomed
          ],
        },
      },
      me: BOT,
    });

    expect(isTelegramChatEnabled).toHaveBeenCalledWith('-100123');
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith('-100123', expect.stringContaining('New Member'));
  });

  it('downloads voice bytes and attaches a Buffer, never a token-bearing URL, to the dispatched payload', async () => {
    const { client, bot, processTelegramEvent, downloadTelegramVoice } = await setup();
    await client.start();

    await bot.handlers.get('message')?.({
      update: {
        message: {
          message_id: 8,
          date: 1_735_689_600,
          chat: { id: -100123, type: 'group' },
          from: { id: 42, first_name: 'Ada' },
          voice: { file_id: 'voice-file-1', file_unique_id: 'u1', duration: 3, mime_type: 'audio/ogg' },
        },
      },
      me: BOT,
    });

    expect(downloadTelegramVoice).toHaveBeenCalledWith('super-secret-token-abc', 'voice-file-1');
    const [, payload] = processTelegramEvent.mock.calls[0] as [unknown, Record<string, unknown>];
    const audio = payload.audio as { url: string; contentType: string; buffer?: Buffer };
    expect(audio.buffer).toBeInstanceOf(Buffer);
    expect(audio.url).toBe('telegram-file:voice-file-1');
    // CREDENTIAL RULE: the placeholder url must never contain the bot token.
    expect(audio.url).not.toContain('super-secret-token-abc');
  });

  it('CREDENTIAL RULE: no call into processTelegramEvent, sendText, or console/logger ever carries the bot token substring', async () => {
    const { client, bot, processTelegramEvent, sendText } = await setup();
    await client.start();

    await bot.handlers.get('message')?.({
      update: {
        message: {
          message_id: 9,
          date: 1_735_689_600,
          chat: { id: -100123, type: 'group' },
          from: { id: 42, first_name: 'Ada' },
          voice: { file_id: 'voice-file-2', file_unique_id: 'u2', duration: 3, mime_type: 'audio/ogg' },
        },
      },
      me: BOT,
    });

    const token = 'super-secret-token-abc';
    for (const call of [...processTelegramEvent.mock.calls, ...sendText.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(token);
    }
  });

  it('stops the underlying bot on stop()', async () => {
    const { client, bot } = await setup();
    await client.start();
    await client.stop();

    expect(bot.stop).toHaveBeenCalled();
  });

  it('F7 (T2 review): does not call downloadTelegramVoice for a disabled/unconfigured group chat', async () => {
    const { client, bot, processTelegramEvent, downloadTelegramVoice, isTelegramChatEnabled } = await setup({
      isChatEnabled: () => false,
    });
    await client.start();

    await bot.handlers.get('message')?.({
      update: {
        message: {
          message_id: 10,
          date: 1_735_689_600,
          chat: { id: -100999, type: 'group' },
          from: { id: 42, first_name: 'Ada' },
          voice: { file_id: 'voice-file-gated', file_unique_id: 'u3', duration: 3, mime_type: 'audio/ogg' },
        },
      },
      me: BOT,
    });

    expect(isTelegramChatEnabled).toHaveBeenCalledWith('-100999');
    expect(downloadTelegramVoice).not.toHaveBeenCalled();
    const [, payload] = processTelegramEvent.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload.audio).toBeUndefined();
  });

  it('F7 (T2 review): still downloads voice for a DM (private chat), which is never chat-config-gated', async () => {
    const { client, bot, downloadTelegramVoice, isTelegramChatEnabled } = await setup({
      isChatEnabled: () => false,
    });
    await client.start();

    await bot.handlers.get('message')?.({
      update: {
        message: {
          message_id: 11,
          date: 1_735_689_600,
          chat: { id: 111, type: 'private' },
          from: { id: 111, first_name: 'Owner' },
          voice: { file_id: 'voice-file-dm', file_unique_id: 'u4', duration: 3, mime_type: 'audio/ogg' },
        },
      },
      me: BOT,
    });

    expect(isTelegramChatEnabled).not.toHaveBeenCalled();
    expect(downloadTelegramVoice).toHaveBeenCalledWith('super-secret-token-abc', 'voice-file-dm');
  });

  it('F7 (T2 review): still downloads voice for an enabled group chat', async () => {
    const { client, bot, downloadTelegramVoice } = await setup({ isChatEnabled: () => true });
    await client.start();

    await bot.handlers.get('message')?.({
      update: {
        message: {
          message_id: 12,
          date: 1_735_689_600,
          chat: { id: -100123, type: 'group' },
          from: { id: 42, first_name: 'Ada' },
          voice: { file_id: 'voice-file-enabled', file_unique_id: 'u5', duration: 3, mime_type: 'audio/ogg' },
        },
      },
      me: BOT,
    });

    expect(downloadTelegramVoice).toHaveBeenCalledWith('super-secret-token-abc', 'voice-file-enabled');
  });

  it('F8 (T2 review): does not false-positive a bot username substring inside a longer @mention-like token', async () => {
    const { client, bot, processTelegramEvent } = await setup();
    await client.start();

    await bot.handlers.get('message')?.({
      update: {
        message: {
          message_id: 13,
          date: 1_735_689_600,
          chat: { id: -100123, type: 'group' },
          from: { id: 42, first_name: 'Ada' },
          // BOT.username is 'GarbanzoBot' — this embeds it as a substring
          // inside a longer token that is NOT actually a mention.
          text: 'email me at @GarbanzoBotmail.com please',
        },
      },
      me: BOT,
    });

    const [, payload] = processTelegramEvent.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload.mentionedIds).toEqual([]);
  });

  it('F8 (T2 review): still recognizes a genuine @username mention at a word boundary', async () => {
    const { client, bot, processTelegramEvent } = await setup();
    await client.start();

    await bot.handlers.get('message')?.({
      update: {
        message: {
          message_id: 14,
          date: 1_735_689_600,
          chat: { id: -100123, type: 'group' },
          from: { id: 42, first_name: 'Ada' },
          text: 'hey @GarbanzoBot, help me out',
        },
      },
      me: BOT,
    });

    const [, payload] = processTelegramEvent.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload.mentionedIds).toEqual([String(BOT.id)]);
  });

  it('F4 (T2 review): marks health connected once long-polling starts successfully', async () => {
    const { client, markConnected, markDisconnected } = await setup({
      botStartImpl: async (opts) => {
        opts?.onStart?.({ id: BOT.id, username: BOT.username });
      },
    });

    await client.start();

    expect(markConnected).toHaveBeenCalledTimes(1);
    expect(markDisconnected).not.toHaveBeenCalled();
  });

  it('F4 (T2 review): marks health disconnected when the poll loop dies on a rethrown error (e.g. 401/409)', async () => {
    const authError = new Error('401: Unauthorized');
    const { client, markDisconnected } = await setup({
      botStartImpl: async () => {
        throw authError;
      },
    });

    await client.start();
    // start() intentionally does not await the polling promise — let the
    // rejection's .catch() microtask run.
    await Promise.resolve();
    await Promise.resolve();

    expect(markDisconnected).toHaveBeenCalledTimes(1);
  });

  it('F4 (T2 review): marks health disconnected on an intentional stop()', async () => {
    const { client, markDisconnected } = await setup();
    await client.start();
    await client.stop();

    expect(markDisconnected).toHaveBeenCalledTimes(1);
  });
});
