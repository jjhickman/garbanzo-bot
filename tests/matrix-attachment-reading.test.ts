process.env.MESSAGING_PLATFORM ??= 'matrix';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.MATRIX_HOMESERVER_URL ??= 'https://matrix.example.org';
process.env.MATRIX_ACCESS_TOKEN ??= 'test_matrix_token';
process.env.MATRIX_OWNER_ID ??= '@owner:example.org';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageContext } from '../src/ai/persona.js';
import type { VisionImage } from '../src/core/vision.js';
import type { MatrixClientLike, RawMatrixEvent } from '../src/platforms/matrix/client.js';
import type { MatrixAttachmentDeps, MatrixQuotedEventLike } from '../src/platforms/matrix/attachment-reading.js';

type FeaturePredicate = (chatId: string, feature: string) => boolean;
type MockGetResponse = (
  query: string,
  ctx: MessageContext,
  isFeatureEnabled: FeaturePredicate,
  visionImages?: VisionImage[],
) => Promise<string | null>;

const BOT = { userId: '@garbanzo:example.org', displayName: 'Garbanzo' };

// ── Unit: client maps reply relations to quotedEventId ──────────────

describe('matrix client quotedEventId mapping', () => {
  it('threads m.in_reply_to event ids into the mapped payload', async () => {
    const { mapMatrixMessageToPayload } = await import('../src/platforms/matrix/client.js');

    const payload = mapMatrixMessageToPayload('!room:example.org', {
      event_id: '$reply',
      type: 'm.room.message',
      sender: '@ada:example.org',
      origin_server_ts: 1_735_689_600_000,
      content: {
        msgtype: 'm.text',
        body: '> <@bea:example.org> original\n\n@garbanzo:example.org what is this?',
        'm.relates_to': { 'm.in_reply_to': { event_id: '$original' } },
      },
    }, BOT);

    expect(payload?.quotedEventId).toBe('$original');
  });

  it('leaves quotedEventId unset for non-reply messages', async () => {
    const { mapMatrixMessageToPayload } = await import('../src/platforms/matrix/client.js');

    const payload = mapMatrixMessageToPayload('!room:example.org', {
      event_id: '$plain',
      type: 'm.room.message',
      sender: '@ada:example.org',
      content: { msgtype: 'm.text', body: 'hello' },
    }, BOT);

    expect(payload?.quotedEventId).toBeUndefined();
  });
});

// ── Unit: Matrix collector ──────────────────────────────────────────

describe('matrix attachment collector', () => {
  function makeDeps(overrides: Partial<MatrixAttachmentDeps> = {}): MatrixAttachmentDeps & {
    fetchEvent: ReturnType<typeof vi.fn>;
    download: ReturnType<typeof vi.fn>;
  } {
    return {
      fetchEvent: vi.fn(async () => null),
      download: vi.fn(async () => Buffer.from('mxc-bytes')),
      ...overrides,
    } as never;
  }

  async function importCollector() {
    return import('../src/platforms/matrix/attachment-reading.js');
  }

  it('maps quoted m.image/m.video/m.audio/m.file events to readable attachments', async () => {
    const { mapMatrixQuotedAttachment } = await importCollector();
    const deps = makeDeps();

    const quoted = (content: MatrixQuotedEventLike['content']) =>
      mapMatrixQuotedAttachment({ type: 'm.room.message', content }, deps);

    expect(quoted({ msgtype: 'm.image', url: 'mxc://x/1', body: 'p.png', info: { mimetype: 'image/png', size: 5 } }))
      .toMatchObject({ kind: 'image', contentType: 'image/png', fileName: 'p.png' });
    expect(quoted({ msgtype: 'm.video', url: 'mxc://x/2', info: { mimetype: 'video/mp4' } }))
      .toMatchObject({ kind: 'video', contentType: 'video/mp4' });
    expect(quoted({ msgtype: 'm.audio', url: 'mxc://x/3' }))
      .toMatchObject({ kind: 'audio', contentType: 'audio/ogg' });
    expect(quoted({ msgtype: 'm.file', url: 'mxc://x/4', filename: 'notes.pdf', info: { mimetype: 'application/pdf' } }))
      .toMatchObject({ kind: 'document', contentType: 'application/pdf', fileName: 'notes.pdf' });

    expect(quoted({ msgtype: 'm.text', body: 'just text' })).toBeNull();
    expect(mapMatrixQuotedAttachment({ type: 'm.room.member' }, deps)).toBeNull();
  });

  it('downloads quoted bytes with the declared size (precondition preserved)', async () => {
    const { mapMatrixQuotedAttachment } = await importCollector();
    const deps = makeDeps();

    const att = mapMatrixQuotedAttachment({
      type: 'm.room.message',
      content: { msgtype: 'm.image', url: 'mxc://x/5', info: { mimetype: 'image/png', size: 123 } },
    }, deps);

    await att?.bytes();
    expect(deps.download).toHaveBeenCalledWith('mxc://x/5', 123);
  });

  it('fetches the referenced event only when the message has no attachment of its own', async () => {
    const { collectMatrixAttachments } = await importCollector();
    const deps = makeDeps({
      fetchEvent: vi.fn(async () => ({
        type: 'm.room.message',
        content: { msgtype: 'm.image', url: 'mxc://x/q', info: { mimetype: 'image/jpeg', size: 9 } },
      })),
    });

    const direct = await collectMatrixAttachments({
      roomId: '!room:example.org',
      media: { url: 'mxc://x/own', contentType: 'image/png', kind: 'image', size: 4 },
      quotedEventId: '$quoted',
      deps,
    });
    expect(direct).toHaveLength(1);
    expect(deps.fetchEvent).not.toHaveBeenCalled();

    const quoted = await collectMatrixAttachments({
      roomId: '!room:example.org',
      quotedEventId: '$quoted',
      deps,
    });
    expect(deps.fetchEvent).toHaveBeenCalledWith('!room:example.org', '$quoted');
    expect(quoted).toHaveLength(1);
    expect(quoted[0]).toMatchObject({ kind: 'image', contentType: 'image/jpeg' });
  });

  it('prefers an already-downloaded direct buffer over a fresh download', async () => {
    const { collectMatrixAttachments } = await importCollector();
    const deps = makeDeps();

    const attachments = await collectMatrixAttachments({
      roomId: '!room:example.org',
      media: { url: 'mxc://x/own', contentType: 'image/png', kind: 'image', buffer: Buffer.from('cached'), size: 6 },
      deps,
    });

    expect(await attachments[0].bytes()).toEqual(Buffer.from('cached'));
    expect(deps.download).not.toHaveBeenCalled();
  });

  it('returns nothing when the referenced event cannot be fetched or deps are absent', async () => {
    const { collectMatrixAttachments } = await importCollector();

    expect(await collectMatrixAttachments({
      roomId: '!room:example.org',
      quotedEventId: '$quoted',
      deps: makeDeps(),
    })).toEqual([]);

    expect(await collectMatrixAttachments({
      roomId: '!room:example.org',
      quotedEventId: '$quoted',
    })).toEqual([]);
  });
});

// ── Wiring: processor reads attachments into the group dispatch ─────

describe('matrix processor attachment wiring', () => {
  const prepareForVision = vi.fn<(media: unknown) => Promise<VisionImage[]>>();
  const transcribeAudio = vi.fn<(buffer: Buffer, mime?: string) => Promise<string | null>>();
  let savedWhisperUrl: string | undefined;

  function setupMocks() {
    const getResponse = vi.fn<MockGetResponse>(async () => 'ok');

    vi.doMock('../src/platforms/matrix/matrix-config.js', () => ({
      isMatrixRoomEnabled: vi.fn(() => true),
      matrixRoomRequiresMention: vi.fn(() => true),
      isMatrixFeatureEnabled: vi.fn(() => false),
      getMatrixRoomName: vi.fn(() => 'lounge'),
    }));
    vi.doMock('../src/core/response-router.js', () => ({ getResponse }));
    vi.doMock('../src/core/vision.js', () => ({ prepareForVision }));
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio }));

    return { getResponse };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    prepareForVision.mockReset();
    transcribeAudio.mockReset();
    savedWhisperUrl = process.env.WHISPER_URL;
    process.env.WHISPER_URL = 'http://whisper.test:8090';
  });

  afterEach(() => {
    if (savedWhisperUrl === undefined) delete process.env.WHISPER_URL;
    else process.env.WHISPER_URL = savedWhisperUrl;
    vi.doUnmock('../src/platforms/matrix/matrix-config.js');
    vi.doUnmock('../src/core/response-router.js');
    vi.doUnmock('../src/core/vision.js');
    vi.doUnmock('../src/features/voice.js');
  });

  function makeDeps(quotedEvent: MatrixQuotedEventLike | null, downloadResult: Buffer | null = Buffer.from('mxc-bytes')) {
    return {
      fetchEvent: vi.fn(async () => quotedEvent),
      download: vi.fn(async () => downloadResult),
    };
  }

  async function drive(event: Record<string, unknown>, attachments: ReturnType<typeof makeDeps>) {
    const { processMatrixEvent } = await import('../src/platforms/matrix/processor.js');
    await processMatrixEvent(
      { sendText: vi.fn(async () => undefined) } as never,
      {
        messageId: '$msg',
        roomId: '!room:example.org',
        isGroupChat: true,
        senderId: '@ada:example.org',
        timestampMs: Date.now(),
        mentionedIds: [BOT.userId],
        ...event,
      },
      { ownerId: '@owner:example.org', botUserId: BOT.userId, botDisplayName: BOT.displayName, attachments },
    );
  }

  it('feeds a QUOTED m.image behind an engaged reply to vision', async () => {
    const { getResponse } = setupMocks();
    const images: VisionImage[] = [{ base64: 'cQ==', mediaType: 'image/png' }];
    prepareForVision.mockResolvedValue(images);
    const deps = makeDeps({
      type: 'm.room.message',
      content: { msgtype: 'm.image', url: 'mxc://x/q', info: { mimetype: 'image/png', size: 9 } },
    });

    await drive({ text: 'what is this?', quotedEventId: '$original' }, deps);

    expect(deps.fetchEvent).toHaveBeenCalledWith('!room:example.org', '$original');
    expect(deps.download).toHaveBeenCalledWith('mxc://x/q', 9);
    expect(getResponse).toHaveBeenCalledWith('what is this?', expect.anything(), expect.any(Function), images);
  });

  it('appends the QUOTED m.audio transcript behind an engaged reply', async () => {
    const { getResponse } = setupMocks();
    transcribeAudio.mockResolvedValue('load in at five');
    const deps = makeDeps({
      type: 'm.room.message',
      content: { msgtype: 'm.audio', url: 'mxc://x/v', info: { mimetype: 'audio/ogg', size: 7 } },
    });

    await drive({ text: 'what did they say?', quotedEventId: '$voice' }, deps);

    expect(transcribeAudio).toHaveBeenCalledWith(Buffer.from('mxc-bytes'), 'audio/ogg');
    expect(getResponse).toHaveBeenCalledWith(
      'what did they say?\n\n[voice message transcript] load in at five',
      expect.anything(),
      expect.any(Function),
      undefined,
    );
  });

  it('adds a context line for a QUOTED m.file', async () => {
    const { getResponse } = setupMocks();
    const deps = makeDeps({
      type: 'm.room.message',
      content: { msgtype: 'm.file', url: 'mxc://x/f', filename: 'setlist.pdf', info: { mimetype: 'application/pdf', size: 11 } },
    });

    await drive({ text: 'summarize that', quotedEventId: '$file' }, deps);

    expect(deps.download).not.toHaveBeenCalled();
    expect(getResponse).toHaveBeenCalledWith(
      'summarize that\n\n[attachment: setlist.pdf (application/pdf)]',
      expect.anything(),
      expect.any(Function),
      undefined,
    );
  });

  it('reads the message own m.image (direct media) for vision', async () => {
    const { getResponse } = setupMocks();
    const images: VisionImage[] = [{ base64: 'ZA==', mediaType: 'image/png' }];
    prepareForVision.mockResolvedValue(images);
    const deps = makeDeps(null);

    await drive({
      text: `${BOT.userId} look at this`,
      media: { url: 'mxc://x/own', contentType: 'image/png', fileName: 'photo.png', kind: 'image', size: 4 },
    }, deps);

    expect(deps.download).toHaveBeenCalledWith('mxc://x/own', 4);
    expect(getResponse).toHaveBeenCalledWith('look at this', expect.anything(), expect.any(Function), images);
  });

  it('degrades a failed download to a context line', async () => {
    const { getResponse } = setupMocks();
    const deps = makeDeps({
      type: 'm.room.message',
      content: { msgtype: 'm.image', url: 'mxc://x/q', body: 'photo.png', info: { mimetype: 'image/png', size: 9 } },
    }, null);

    await drive({ text: 'can you see this?', quotedEventId: '$original' }, deps);

    expect(getResponse).toHaveBeenCalledWith(
      'can you see this?\n\n[attachment: photo.png (image/png)]',
      expect.anything(),
      expect.any(Function),
      undefined,
    );
  });

  it('never fetches the referenced event for unengaged messages or bang commands', async () => {
    const { getResponse } = setupMocks();
    const deps = makeDeps({
      type: 'm.room.message',
      content: { msgtype: 'm.image', url: 'mxc://x/q', info: { mimetype: 'image/png', size: 9 } },
    });

    // Reply to a non-bot message in a require-mention room: not engaged.
    await drive({ text: 'nice shot', mentionedIds: [], quotedEventId: '$original' }, deps);
    expect(deps.fetchEvent).not.toHaveBeenCalled();
    expect(getResponse).not.toHaveBeenCalled();

    // Bang command: raw query preserved, no reads.
    await drive({ text: '!weather boston', quotedEventId: '$original' }, deps);
    expect(deps.fetchEvent).not.toHaveBeenCalled();
    expect(getResponse).toHaveBeenCalledWith('!weather boston', expect.anything(), expect.any(Function), undefined);
  });

  it('does not regress the direct audio flow (transcript-as-text, no attachment read)', async () => {
    const { getResponse } = setupMocks();
    transcribeAudio.mockResolvedValue('direct matrix voice');
    const deps = makeDeps(null);

    await drive({
      text: '',
      audio: { url: 'mxc://x/direct', contentType: 'audio/ogg', buffer: Buffer.from([1, 2, 3]) },
    }, deps);

    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(deps.fetchEvent).not.toHaveBeenCalled();
    expect(deps.download).not.toHaveBeenCalled();
    expect(getResponse).toHaveBeenCalledWith('direct matrix voice', expect.anything(), expect.any(Function), undefined);
  });
});

// ── Wiring: client supplies lazy fetch/download capabilities ────────

describe('matrix client attachment capability wiring', () => {
  beforeEach(() => {
    delete process.env.BRIDGE_MEDIA_ENABLED;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function createFakeClient(): MatrixClientLike & { handlers: Map<string, (...args: unknown[]) => unknown> } {
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
      getEvent: vi.fn(async () => ({
        type: 'm.room.message',
        content: { msgtype: 'm.image', url: 'mxc://example.org/q', info: { mimetype: 'image/png', size: 3 } },
      })),
      downloadContent: vi.fn(async () => Buffer.from([9, 9, 9])),
      joinRoom: vi.fn(async () => undefined),
    } as never;
  }

  it('passes quotedEventId and working attachment capabilities to the processor', async () => {
    const fakeClient = createFakeClient();
    const processMatrixEvent = vi.fn(async () => undefined);

    vi.doMock('../src/platforms/matrix/processor.js', () => ({ processMatrixEvent }));
    vi.doMock('../src/platforms/matrix/matrix-config.js', () => ({
      isMatrixRoomEnabled: vi.fn(() => true),
      getMatrixRoomName: vi.fn(() => undefined),
    }));
    vi.doMock('../src/middleware/health.js', () => ({ markConnected: vi.fn(), markDisconnected: vi.fn() }));
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../src/bridge/bridge-map.js', () => ({ chatHasMediaRelayRoute: vi.fn(() => false) }));

    const module = await import('../src/platforms/matrix/client.js');
    const client = module.createMatrixClient({
      homeserverUrl: 'https://matrix.example.org',
      accessToken: 'super-secret-matrix-token',
      ownerId: '@owner:example.org',
      client: fakeClient,
      nodeVersion: 'v22.0.0',
      resolveOwnerRoomId: vi.fn(async () => '!dm:example.org'),
    });
    await client.start();

    const event: RawMatrixEvent = {
      event_id: '$reply',
      type: 'm.room.message',
      sender: '@ada:example.org',
      origin_server_ts: Date.now(),
      content: {
        msgtype: 'm.text',
        body: '> <@bea:example.org> original\n\n@garbanzo:example.org what is this?',
        'm.relates_to': { 'm.in_reply_to': { event_id: '$original' } },
      },
    };
    fakeClient.handlers.get('room.message')?.('!room:example.org', event);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(processMatrixEvent).toHaveBeenCalledTimes(1);
    const [, payload, env] = processMatrixEvent.mock.calls[0] as [
      unknown,
      { quotedEventId?: string },
      { attachments?: MatrixAttachmentDeps },
    ];
    expect(payload.quotedEventId).toBe('$original');

    // The capabilities are live: getEvent fetch was NOT eager …
    expect(fakeClient.getEvent).not.toHaveBeenCalled();
    // … and resolves lazily through the real client with bounded download.
    const fetched = await env.attachments?.fetchEvent('!room:example.org', '$original');
    expect(fakeClient.getEvent).toHaveBeenCalledWith('!room:example.org', '$original');
    expect(fetched?.content?.url).toBe('mxc://example.org/q');

    const bytes = await env.attachments?.download('mxc://example.org/q', 3);
    expect(bytes).toEqual(Buffer.from([9, 9, 9]));
  });
});
