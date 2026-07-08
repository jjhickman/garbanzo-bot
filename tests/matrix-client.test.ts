process.env.MESSAGING_PLATFORM ??= 'matrix';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.MATRIX_HOMESERVER_URL ??= 'https://matrix.example.org';
process.env.MATRIX_ACCESS_TOKEN ??= 'test_matrix_token';
process.env.MATRIX_OWNER_ID ??= '@owner:example.org';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MatrixClientLike, RawMatrixEvent } from '../src/platforms/matrix/client.js';

const BOT = { userId: '@garbanzo:example.org', displayName: 'Garbanzo' };

function baseEvent(overrides: Partial<RawMatrixEvent> = {}): RawMatrixEvent {
  return {
    event_id: '$event1',
    room_id: '!room:example.org',
    type: 'm.room.message',
    sender: '@ada:example.org',
    origin_server_ts: 1_735_689_600_000,
    content: { msgtype: 'm.text', body: 'hello there' },
    ...overrides,
  };
}

function createFakeClient(): MatrixClientLike & {
  handlers: Map<string, (...args: unknown[]) => unknown>;
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    }),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getUserId: vi.fn(async () => BOT.userId),
    getUserProfile: vi.fn(async () => ({ displayname: BOT.displayName })),
    sendMessage: vi.fn(async () => '$sent'),
    downloadContent: vi.fn(async () => Buffer.from([1, 2, 3])),
    joinRoom: vi.fn(async () => undefined),
  };
}

describe('mapMatrixMessageToPayload', () => {
  it('maps basic text fields and uses the sender mxid localpart as senderName', async () => {
    const { mapMatrixMessageToPayload } = await import('../src/platforms/matrix/client.js');
    const payload = mapMatrixMessageToPayload('!room:example.org', baseEvent(), BOT);

    expect(payload).toMatchObject({
      messageId: '$event1',
      roomId: '!room:example.org',
      isGroupChat: true,
      text: 'hello there',
      senderId: '@ada:example.org',
      senderName: 'ada',
      timestampMs: 1_735_689_600_000,
      fromSelf: false,
    });
  });

  it('strips plain mx-reply fallback from the text and quoted body', async () => {
    const { mapMatrixMessageToPayload } = await import('../src/platforms/matrix/client.js');
    const payload = mapMatrixMessageToPayload('!room:example.org', baseEvent({
      content: {
        msgtype: 'm.text',
        body: '> <@ada:example.org> original\n> second line\n\nreply text',
        'm.relates_to': { 'm.in_reply_to': { event_id: '$old' } },
      },
    }), BOT);

    expect(payload?.text).toBe('reply text');
    expect(payload?.quotedText).toBe('<@ada:example.org> original\nsecond line');
    expect(payload?.mentionedIds).toContain(BOT.userId);
  });

  it('strips formatted mx-reply fallback from formatted body without leaking it into text', async () => {
    const { mapMatrixMessageToPayload } = await import('../src/platforms/matrix/client.js');
    const payload = mapMatrixMessageToPayload('!room:example.org', baseEvent({
      content: {
        msgtype: 'm.text',
        body: 'reply text',
        formatted_body: '<mx-reply><blockquote>old</blockquote></mx-reply><strong>reply</strong>',
        format: 'org.matrix.custom.html',
        'm.relates_to': { 'm.in_reply_to': { event_id: '$old' } },
      },
    }), BOT);

    expect(payload?.text).toBe('reply text');
    expect(payload?.quotedText).toBeUndefined();
    expect(payload?.mentionedIds).toContain(BOT.userId);
  });

  it('maps m.mentions user ids and display-name text matches as bot mentions', async () => {
    const { mapMatrixMessageToPayload } = await import('../src/platforms/matrix/client.js');
    const byMentions = mapMatrixMessageToPayload('!room:example.org', baseEvent({
      content: {
        msgtype: 'm.text',
        body: 'hello',
        'm.mentions': { user_ids: [BOT.userId] },
      },
    }), BOT);
    const byDisplayName = mapMatrixMessageToPayload('!room:example.org', baseEvent({
      content: { msgtype: 'm.text', body: 'Garbanzo: help' },
    }), BOT);

    expect(byMentions?.mentionedIds).toContain(BOT.userId);
    expect(byDisplayName?.mentionedIds).toContain(BOT.userId);
  });

  it('surfaces Matrix audio mxc URI and mimetype', async () => {
    const { mapMatrixMessageToPayload } = await import('../src/platforms/matrix/client.js');
    const payload = mapMatrixMessageToPayload('!room:example.org', baseEvent({
      content: {
        msgtype: 'm.audio',
        body: 'voice note',
        url: 'mxc://example.org/media',
        info: { mimetype: 'audio/ogg' },
      },
    }), BOT);

    expect(payload?.audio).toEqual({ mxcUrl: 'mxc://example.org/media', mimeType: 'audio/ogg' });
  });

  it('marks fromSelf for bot-authored events', async () => {
    const { mapMatrixMessageToPayload } = await import('../src/platforms/matrix/client.js');
    const payload = mapMatrixMessageToPayload('!room:example.org', baseEvent({ sender: BOT.userId }), BOT);
    expect(payload?.fromSelf).toBe(true);
  });
});

describe('Matrix client handler wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function setup(options: {
    isRoomEnabled?: (roomId: string) => boolean;
    resolveOwnerRoomId?: () => Promise<string | null>;
  } = {}) {
    const fakeClient = createFakeClient();
    const processMatrixEvent = vi.fn(async () => undefined);
    const isMatrixRoomEnabled = vi.fn(options.isRoomEnabled ?? (() => true));
    const markConnected = vi.fn();
    const markDisconnected = vi.fn();
    const loggerWarn = vi.fn();

    vi.doMock('../src/platforms/matrix/processor.js', () => ({ processMatrixEvent }));
    vi.doMock('../src/platforms/matrix/matrix-config.js', () => ({
      isMatrixRoomEnabled,
      getMatrixRoomName: vi.fn(() => undefined),
    }));
    vi.doMock('../src/platforms/matrix/welcome.js', () => ({
      buildMatrixWelcomeMessage: vi.fn(() => 'welcome text'),
    }));
    vi.doMock('../src/middleware/health.js', () => ({ markConnected, markDisconnected }));
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: loggerWarn, error: vi.fn() },
    }));

    const module = await import('../src/platforms/matrix/client.js');
    const client = module.createMatrixClient({
      homeserverUrl: 'https://matrix.example.org',
      accessToken: 'super-secret-matrix-token',
      ownerId: '@owner:example.org',
      client: fakeClient,
      nodeVersion: 'v22.0.0',
      resolveOwnerRoomId: vi.fn(options.resolveOwnerRoomId ?? (async () => '!dm:example.org')),
    });

    return { client, fakeClient, processMatrixEvent, isMatrixRoomEnabled, markConnected, markDisconnected, loggerWarn };
  }

  it('asserts Node >=22 for Matrix runtime construction', async () => {
    const { assertMatrixNodeVersion } = await import('../src/platforms/matrix/client.js');
    expect(() => assertMatrixNodeVersion('v20.11.0')).toThrow(/Node\.js >=22/);
    expect(() => assertMatrixNodeVersion('v22.0.0')).not.toThrow();
  });

  it('registers Matrix event handlers, resolves identity, and marks connected on first sync', async () => {
    const { client, fakeClient, markConnected } = await setup();
    await client.start();

    expect(fakeClient.on).toHaveBeenCalledWith('room.message', expect.any(Function));
    expect(fakeClient.on).toHaveBeenCalledWith('room.event', expect.any(Function));
    expect(fakeClient.on).toHaveBeenCalledWith('room.invite', expect.any(Function));

    fakeClient.handlers.get('sync')?.();
    expect(markConnected).toHaveBeenCalledTimes(1);
  });

  it('dispatches text messages to processMatrixEvent', async () => {
    const { client, fakeClient, processMatrixEvent } = await setup();
    await client.start();

    fakeClient.handlers.get('room.message')?.('!room:example.org', baseEvent());
    await Promise.resolve();

    expect(processMatrixEvent).toHaveBeenCalledTimes(1);
    const [, payload, env] = processMatrixEvent.mock.calls[0] as [unknown, Record<string, unknown>, Record<string, unknown>];
    expect(payload.roomId).toBe('!room:example.org');
    expect(payload.senderId).toBe('@ada:example.org');
    expect(env.botUserId).toBe(BOT.userId);
  });

  it('drops fromSelf messages without dispatching', async () => {
    const { client, fakeClient, processMatrixEvent } = await setup();
    await client.start();

    fakeClient.handlers.get('room.message')?.('!room:example.org', baseEvent({ sender: BOT.userId }));
    await Promise.resolve();

    expect(processMatrixEvent).not.toHaveBeenCalled();
  });

  it('gates room before downloading Matrix audio', async () => {
    const { client, fakeClient, processMatrixEvent, isMatrixRoomEnabled } = await setup({
      isRoomEnabled: () => false,
    });
    await client.start();

    fakeClient.handlers.get('room.message')?.('!room:example.org', baseEvent({
      content: {
        msgtype: 'm.audio',
        body: 'voice',
        url: 'mxc://example.org/audio',
        info: { mimetype: 'audio/ogg' },
      },
    }));
    await Promise.resolve();

    expect(isMatrixRoomEnabled).toHaveBeenCalledWith('!room:example.org');
    expect(fakeClient.downloadContent).not.toHaveBeenCalled();
    const [, payload] = processMatrixEvent.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload.audio).toBeUndefined();
  });

  it('downloads audio for enabled rooms without exposing the access token', async () => {
    const { client, fakeClient, processMatrixEvent } = await setup();
    await client.start();

    fakeClient.handlers.get('room.message')?.('!room:example.org', baseEvent({
      content: {
        msgtype: 'm.audio',
        body: 'voice',
        url: 'mxc://example.org/audio',
        info: { mimetype: 'audio/ogg' },
      },
    }));
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(fakeClient.downloadContent).toHaveBeenCalledWith('mxc://example.org/audio');
    const [, payload] = processMatrixEvent.mock.calls[0] as [unknown, Record<string, unknown>];
    const audio = payload.audio as { url: string; contentType: string; buffer?: Buffer };
    expect(audio.url).toBe('mxc://example.org/audio');
    expect(JSON.stringify(processMatrixEvent.mock.calls)).not.toContain('super-secret-matrix-token');
  });

  it('welcomes member joins in configured rooms', async () => {
    const { client, fakeClient } = await setup();
    await client.start();

    fakeClient.handlers.get('room.event')?.('!room:example.org', {
      type: 'm.room.member',
      state_key: '@new:example.org',
      content: { membership: 'join' },
    });
    await Promise.resolve();

    expect(fakeClient.sendMessage).toHaveBeenCalledWith('!room:example.org', expect.objectContaining({
      body: 'welcome text',
    }));
  });

  it('logs a clear warning for encrypted rooms', async () => {
    const { client, fakeClient, loggerWarn } = await setup();
    await client.start();

    fakeClient.handlers.get('room.event')?.('!room:example.org', { type: 'm.room.encryption', content: {} });
    await Promise.resolve();

    expect(loggerWarn).toHaveBeenCalledWith(
      { roomId: '!room:example.org' },
      'Matrix encrypted rooms are unsupported; messages in this room are invisible to Garbanzo',
    );
  });

  it('auto-joins invites only for configured enabled rooms', async () => {
    const { client, fakeClient } = await setup({ isRoomEnabled: (roomId) => roomId === '!enabled:example.org' });
    await client.start();

    fakeClient.handlers.get('room.invite')?.('!disabled:example.org');
    fakeClient.handlers.get('room.invite')?.('!enabled:example.org');
    await Promise.resolve();
    await Promise.resolve();

    expect(fakeClient.joinRoom).toHaveBeenCalledTimes(1);
    expect(fakeClient.joinRoom).toHaveBeenCalledWith('!enabled:example.org');
  });
});
