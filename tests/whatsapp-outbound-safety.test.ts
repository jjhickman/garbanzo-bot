import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  countWhatsAppSentSince: vi.fn(async () => 0),
  createWhatsAppOutboundJob: vi.fn(),
  getWhatsAppOutboundJob: vi.fn(),
  getWhatsAppSafetyMetrics: vi.fn(),
  getWhatsAppSafetyState: vi.fn(),
  listWhatsAppHeldJobs: vi.fn(),
  recoverWhatsAppPendingJobs: vi.fn(async () => 0),
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
    WHATSAPP_SAFETY_MAX_PER_DAY: 800,
    WHATSAPP_SAFETY_MIN_DELAY_MS: 0,
    WHATSAPP_SAFETY_MAX_DELAY_MS: 0,
    WHATSAPP_SAFETY_WARMUP_DAYS: 0,
    WHATSAPP_SAFETY_DAY1_LIMIT: 15,
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
});
