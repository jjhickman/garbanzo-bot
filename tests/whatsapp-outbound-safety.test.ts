import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  countWhatsAppSentSince: vi.fn(async () => 0),
  createWhatsAppOutboundJob: vi.fn(),
  getWhatsAppOutboundJob: vi.fn(),
  getWhatsAppSafetyMetrics: vi.fn(),
  getWhatsAppSafetyState: vi.fn(),
  listWhatsAppHeldJobs: vi.fn(),
  recoverWhatsAppPendingJobs: vi.fn(async () => 0),
  reconcileHeldNativeEventRef: vi.fn(async () => false),
  setWhatsAppSafetyState: vi.fn(async () => undefined),
  updateWhatsAppOutboundJob: vi.fn(async () => true),
}));

const antiBanMocks = vi.hoisted(() => ({
  beforeSend: vi.fn(),
  afterSend: vi.fn(),
  afterSendFailed: vi.fn(),
  onDisconnect: vi.fn(),
  onReconnect: vi.fn(),
  onIncomingMessage: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('../src/utils/db.js', () => dbMocks);
vi.mock('../src/utils/config.js', () => ({
  PROJECT_ROOT: '/tmp/garbanzo-tests',
  config: {
    WHATSAPP_SAFETY_ENABLED: true,
    WHATSAPP_SAFETY_MAX_PER_MINUTE: 5,
    WHATSAPP_SAFETY_MAX_PER_HOUR: 100,
    WHATSAPP_SAFETY_MAX_PER_DAY: 2000,
    WHATSAPP_SAFETY_MIN_DELAY_MS: 0,
    WHATSAPP_SAFETY_MAX_DELAY_MS: 0,
    WHATSAPP_SAFETY_WARMUP_DAYS: 0,
    WHATSAPP_SAFETY_DAY1_LIMIT: 2000,
    WHATSAPP_SAFETY_AUTO_PAUSE_AT: 'medium',
  },
}));
vi.mock('../src/middleware/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('baileys-antiban', () => ({
  AntiBan: class {
    beforeSend = antiBanMocks.beforeSend;
    afterSend = antiBanMocks.afterSend;
    afterSendFailed = antiBanMocks.afterSendFailed;
    onDisconnect = antiBanMocks.onDisconnect;
    onReconnect = antiBanMocks.onReconnect;
    onIncomingMessage = antiBanMocks.onIncomingMessage;
    pause = antiBanMocks.pause;
    resume = antiBanMocks.resume;
    destroy = antiBanMocks.destroy;
  },
}));

import { createProtectedWhatsAppSocket, getWhatsAppOutboundSafety } from '../src/platforms/whatsapp/outbound-safety.js';

function pendingJob(id: number = 1) {
  return {
    id,
    chatJid: 'group@g.us',
    kind: 'text',
    contentJson: JSON.stringify({ text: 'hello' }),
    optionsJson: null,
    status: 'pending' as const,
    reason: null,
    attempts: 0,
    createdAt: 1,
    updatedAt: 1,
    sentAt: null,
  };
}

describe('WhatsApp outbound safety socket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.createWhatsAppOutboundJob.mockResolvedValue(pendingJob());
    dbMocks.getWhatsAppSafetyState.mockResolvedValue({
      paused: false,
      risk: 'low',
      score: 0,
      reasons: [],
      updatedAt: 0,
    });
    antiBanMocks.beforeSend.mockResolvedValue({
      allowed: true,
      delayMs: 0,
      health: { risk: 'low', score: 0, reasons: [], recommendation: 'normal' },
    });
  });

  it('sends permitted messages through the raw socket and records completion', async () => {
    const raw = { sendMessage: vi.fn(async () => ({ key: { id: 'sent' } })) };
    const sock = createProtectedWhatsAppSocket(raw as never);

    await sock.sendMessage('group@g.us', { text: 'hello' });

    expect(raw.sendMessage).toHaveBeenCalledWith('group@g.us', { text: 'hello' }, undefined);
    expect(dbMocks.updateWhatsAppOutboundJob).toHaveBeenCalledWith(1, 'sent', null, expect.any(Number));
    expect(antiBanMocks.afterSend).toHaveBeenCalledWith('group@g.us', 'hello');
  });

  it('holds output without sending when the persisted policy is paused', async () => {
    dbMocks.getWhatsAppSafetyState.mockResolvedValue({
      paused: true,
      risk: 'medium',
      score: 40,
      reasons: ['paused'],
      updatedAt: 0,
    });
    const raw = { sendMessage: vi.fn(async () => undefined) };
    const sock = createProtectedWhatsAppSocket(raw as never);

    await expect(sock.sendMessage('group@g.us', { text: 'held' })).rejects.toThrow(
      'WhatsApp outbound job #1 held: WhatsApp output paused at risk level medium',
    );

    expect(raw.sendMessage).not.toHaveBeenCalled();
    expect(dbMocks.updateWhatsAppOutboundJob).toHaveBeenCalledWith(
      1,
      'held',
      'WhatsApp output paused at risk level medium',
    );
  });

  it('manually releases a held job through the raw socket', async () => {
    const held = { ...pendingJob(8), status: 'held' as const };
    dbMocks.getWhatsAppOutboundJob.mockResolvedValue(held);
    const raw = { sendMessage: vi.fn(async () => undefined) };
    const sock = createProtectedWhatsAppSocket(raw as never);
    const safety = getWhatsAppOutboundSafety(sock);

    const released = await safety?.releaseHeldJob(8);

    expect(released).toBe(true);
    expect(raw.sendMessage).toHaveBeenCalledWith('group@g.us', { text: 'hello' }, undefined);
    expect(dbMocks.updateWhatsAppOutboundJob).toHaveBeenCalledWith(8, 'sent', 'Released manually by owner', expect.any(Number));
  });

  it('revives held event Dates and links the released event message to its native event record', async () => {
    // Held { event } content round-trips through JSON, so its Date fields
    // come back as ISO strings — Baileys would crash on startDate.getTime().
    const startIso = '2026-08-01T23:00:00.000Z';
    const heldEventJob = {
      ...pendingJob(11),
      status: 'held' as const,
      kind: 'message',
      contentJson: JSON.stringify({ event: { name: 'Trivia', startDate: new Date(startIso), isCancelled: false } }),
    };
    dbMocks.getWhatsAppOutboundJob.mockResolvedValue(heldEventJob);
    const messageSecret = Uint8Array.from([1, 2, 3, 4]);
    const raw = {
      sendMessage: vi.fn(async () => ({
        key: { id: 'sent-evt', remoteJid: 'group@g.us', fromMe: true },
        message: { eventMessage: { name: 'Trivia' }, messageContextInfo: { messageSecret } },
      })),
    };
    const sock = createProtectedWhatsAppSocket(raw as never);
    dbMocks.reconcileHeldNativeEventRef.mockResolvedValue(true);

    const released = await getWhatsAppOutboundSafety(sock)?.releaseHeldJob(11);

    expect(released).toBe(true);
    const [, sentContent] = raw.sendMessage.mock.calls[0] as [string, { event: { startDate: Date } }];
    expect(sentContent.event.startDate).toBeInstanceOf(Date);
    expect(sentContent.event.startDate.toISOString()).toBe(startIso);
    // The {heldJobId:11} native-event ref is repointed at the real message
    // key + messageSecret so member RSVPs match from now on.
    expect(dbMocks.reconcileHeldNativeEventRef).toHaveBeenCalledTimes(1);
    const [jobId, ref] = dbMocks.reconcileHeldNativeEventRef.mock.calls[0] as [number, string];
    expect(jobId).toBe(11);
    expect(JSON.parse(ref)).toMatchObject({
      id: 'sent-evt',
      remoteJid: 'group@g.us',
      fromMe: true,
      messageSecret: Buffer.from(messageSecret).toString('base64'),
    });
    expect(dbMocks.updateWhatsAppOutboundJob).toHaveBeenCalledWith(11, 'sent', 'Released manually by owner', expect.any(Number));
  });

  it('still releases the event job when the native-event ref link fails', async () => {
    const heldEventJob = {
      ...pendingJob(12),
      status: 'held' as const,
      kind: 'message',
      contentJson: JSON.stringify({ event: { name: 'Trivia', startDate: new Date(), isCancelled: false } }),
    };
    dbMocks.getWhatsAppOutboundJob.mockResolvedValue(heldEventJob);
    dbMocks.reconcileHeldNativeEventRef.mockRejectedValue(new Error('db down'));
    const raw = { sendMessage: vi.fn(async () => ({ key: { id: 'sent-evt-2' } })) };
    const sock = createProtectedWhatsAppSocket(raw as never);

    const released = await getWhatsAppOutboundSafety(sock)?.releaseHeldJob(12);

    expect(released).toBe(true);
    expect(dbMocks.updateWhatsAppOutboundJob).toHaveBeenCalledWith(12, 'sent', 'Released manually by owner', expect.any(Number));
  });

  it('retains a held document payload for release, then strips it on the terminal sent transition', async () => {
    dbMocks.getWhatsAppSafetyState.mockResolvedValue({
      paused: true,
      risk: 'medium',
      score: 40,
      reasons: ['paused'],
      updatedAt: 0,
    });
    dbMocks.createWhatsAppOutboundJob.mockResolvedValue({ ...pendingJob(9), kind: 'document' });
    const raw = { sendMessage: vi.fn(async () => undefined) };
    const sock = createProtectedWhatsAppSocket(raw as never);

    await expect(sock.sendMessage('group@g.us', {
      document: Buffer.from([1, 2, 3, 4]),
      mimetype: 'application/pdf',
      fileName: 'bridge.pdf',
    })).rejects.toThrow('held');

    const fullPayload = dbMocks.createWhatsAppOutboundJob.mock.calls[0]?.[2] as string;
    expect(JSON.parse(fullPayload)).toMatchObject({ document: { data: [1, 2, 3, 4] } });
    expect(dbMocks.updateWhatsAppOutboundJob).toHaveBeenCalledWith(
      9,
      'held',
      'WhatsApp output paused at risk level medium',
    );

    dbMocks.getWhatsAppOutboundJob.mockResolvedValue({
      ...pendingJob(9),
      kind: 'document',
      status: 'held' as const,
      contentJson: fullPayload,
    });
    const released = await getWhatsAppOutboundSafety(sock)?.releaseHeldJob(9);

    expect(released).toBe(true);
    expect(raw.sendMessage).toHaveBeenCalledTimes(1);
    expect(dbMocks.updateWhatsAppOutboundJob).toHaveBeenLastCalledWith(
      9,
      'sent',
      'Released manually by owner',
      expect.any(Number),
      JSON.stringify({ kind: 'document', strippedBytes: 4 }),
    );
  });

  it('strips document bytes when a media job is sent', async () => {
    dbMocks.createWhatsAppOutboundJob.mockResolvedValue({ ...pendingJob(10), kind: 'document' });
    const raw = { sendMessage: vi.fn(async () => ({ key: { id: 'sent' } })) };
    const sock = createProtectedWhatsAppSocket(raw as never);

    await sock.sendMessage('group@g.us', {
      document: Buffer.alloc(12),
      mimetype: 'application/pdf',
      fileName: 'bridge.pdf',
    });

    expect(dbMocks.updateWhatsAppOutboundJob).toHaveBeenCalledWith(
      10,
      'sent',
      null,
      expect.any(Number),
      JSON.stringify({ kind: 'document', strippedBytes: 12 }),
    );
  });

  it('strips audio bytes when a media job fails', async () => {
    dbMocks.createWhatsAppOutboundJob.mockResolvedValue({ ...pendingJob(11), kind: 'audio' });
    const raw = { sendMessage: vi.fn(async () => { throw new Error('send failed'); }) };
    const sock = createProtectedWhatsAppSocket(raw as never);

    await expect(sock.sendMessage('group@g.us', {
      audio: Buffer.alloc(7),
      mimetype: 'audio/ogg',
    })).rejects.toThrow('send failed');

    expect(dbMocks.updateWhatsAppOutboundJob).toHaveBeenCalledWith(
      11,
      'failed',
      'send failed',
      undefined,
      JSON.stringify({ kind: 'audio', strippedBytes: 7 }),
    );
  });
});
