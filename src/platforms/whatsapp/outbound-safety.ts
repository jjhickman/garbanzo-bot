import type { WASocket } from '@whiskeysockets/baileys';
import { AntiBan, type HealthStatus } from 'baileys-antiban';

import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import { homePath } from '../../utils/paths.js';
import {
  countWhatsAppSentSince,
  createWhatsAppOutboundJob,
  getWhatsAppOutboundJob,
  getWhatsAppSafetyMetrics,
  getWhatsAppSafetyState,
  listWhatsAppHeldJobs,
  recoverWhatsAppPendingJobs,
  setWhatsAppSafetyState,
  updateWhatsAppOutboundJob,
  type WhatsAppOutboundJob,
  type WhatsAppRiskLevel,
  type WhatsAppSafetyMetrics,
} from '../../utils/db.js';

type SendMessage = WASocket['sendMessage'];
type SendContent = Parameters<SendMessage>[1];
type SendOptions = Parameters<SendMessage>[2];
type SendResult = Awaited<ReturnType<SendMessage>>;

const SECOND = 1000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const riskRank: Record<WhatsAppRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function nowSeconds(): number {
  return Math.floor(Date.now() / SECOND);
}

function contentKind(content: SendContent): string {
  if (typeof content !== 'object' || content === null) return 'unknown';
  for (const kind of ['text', 'react', 'poll', 'document', 'audio', 'delete', 'image', 'video']) {
    if (kind in content) return kind;
  }
  return 'message';
}

function decisionText(content: SendContent): string {
  if (typeof content === 'object' && content !== null && 'text' in content && typeof content.text === 'string') {
    return content.text;
  }
  return `[${contentKind(content)}]`;
}

function serializePayload(value: unknown): string {
  return JSON.stringify(value);
}

function mediaPayloadByteLength(value: unknown): number {
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value !== 'object' || value === null) return 0;

  const serialized = value as { type?: unknown; data?: unknown };
  return serialized.type === 'Buffer' && Array.isArray(serialized.data)
    ? serialized.data.length
    : 0;
}

function terminalMediaContentJson(content: SendContent, kind: string): string | undefined {
  if (kind !== 'document' && kind !== 'audio') return undefined;
  const media = (content as unknown as Record<string, unknown>)[kind];
  return JSON.stringify({ kind, strippedBytes: mediaPayloadByteLength(media) });
}

function parsePayload<T>(value: string | null): T | undefined {
  if (value === null) return undefined;
  return JSON.parse(value) as T;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 300);
  return String(err).slice(0, 300);
}

export class WhatsAppOutboundHeldError extends Error {
  constructor(
    public readonly jobId: number,
    reason: string,
  ) {
    super(`WhatsApp outbound job #${jobId} held: ${reason}`);
    this.name = 'WhatsAppOutboundHeldError';
  }
}

export class WhatsAppOutboundSafety {
  private readonly antiBan: AntiBan;
  private readonly initialized: Promise<void>;

  constructor(private readonly rawSocket: WASocket) {
    this.antiBan = new AntiBan({
      preset: 'conservative',
      maxPerMinute: config.WHATSAPP_SAFETY_MAX_PER_MINUTE,
      maxPerHour: config.WHATSAPP_SAFETY_MAX_PER_HOUR,
      maxPerDay: config.WHATSAPP_SAFETY_MAX_PER_DAY,
      minDelayMs: config.WHATSAPP_SAFETY_MIN_DELAY_MS,
      maxDelayMs: config.WHATSAPP_SAFETY_MAX_DELAY_MS,
      warmupDays: config.WHATSAPP_SAFETY_WARMUP_DAYS,
      day1Limit: config.WHATSAPP_SAFETY_DAY1_LIMIT,
      autoPauseAt: config.WHATSAPP_SAFETY_AUTO_PAUSE_AT,
      persist: homePath('data', 'whatsapp-antiban-state.json'),
      logging: false,
      onRiskChange: (status) => {
        void this.persistRiskStatus(status);
      },
    });
    this.initialized = this.recoverInterruptedSends();
  }

  private async recoverInterruptedSends(): Promise<void> {
    const count = await recoverWhatsAppPendingJobs('Process restarted before send completion; manual release required');
    if (count > 0) {
      logger.warn({ count }, 'Retained interrupted WhatsApp outbound jobs for manual release');
    }
  }

  private async persistRiskStatus(status: HealthStatus): Promise<void> {
    const state = await getWhatsAppSafetyState();
    const automaticPause = riskRank[status.risk] >= riskRank[config.WHATSAPP_SAFETY_AUTO_PAUSE_AT];
    const paused = state.paused || automaticPause;
    await setWhatsAppSafetyState(paused, status.risk, status.score, status.reasons);
    if (automaticPause) {
      logger.warn({ risk: status.risk, score: status.score, reasons: status.reasons }, 'WhatsApp safety automatically paused output');
    }
  }

  private async retentionReason(): Promise<string | null> {
    const state = await getWhatsAppSafetyState();
    if (state.paused) return `WhatsApp output paused at risk level ${state.risk}`;

    const now = nowSeconds();
    const minuteCount = await countWhatsAppSentSince(now - MINUTE_SECONDS);
    if (minuteCount >= config.WHATSAPP_SAFETY_MAX_PER_MINUTE) {
      return 'WhatsApp minute send limit reached';
    }
    const hourCount = await countWhatsAppSentSince(now - HOUR_SECONDS);
    if (hourCount >= config.WHATSAPP_SAFETY_MAX_PER_HOUR) {
      return 'WhatsApp hourly send limit reached';
    }
    const dayCount = await countWhatsAppSentSince(now - DAY_SECONDS);
    if (dayCount >= config.WHATSAPP_SAFETY_MAX_PER_DAY) {
      return 'WhatsApp daily send limit reached';
    }
    return null;
  }

  async sendMessage(chatJid: string, content: SendContent, options?: SendOptions): Promise<SendResult> {
    if (!config.WHATSAPP_SAFETY_ENABLED) {
      return this.rawSocket.sendMessage(chatJid, content, options);
    }

    await this.initialized;
    const kind = contentKind(content);
    const job = await createWhatsAppOutboundJob(
      chatJid,
      kind,
      serializePayload(content),
      options === undefined ? null : serializePayload(options),
    );

    const retainedReason = await this.retentionReason();
    if (retainedReason) {
      await updateWhatsAppOutboundJob(job.id, 'held', retainedReason);
      logger.warn({ jobId: job.id, kind: job.kind, reason: retainedReason }, 'WhatsApp outbound job retained');
      throw new WhatsAppOutboundHeldError(job.id, retainedReason);
    }

    const decision = await this.antiBan.beforeSend(chatJid, decisionText(content));
    await this.persistRiskStatus(decision.health);
    if (!decision.allowed) {
      const reason = decision.reason ?? 'baileys-antiban blocked outbound send';
      await updateWhatsAppOutboundJob(job.id, 'held', reason);
      logger.warn({ jobId: job.id, kind: job.kind, reason }, 'WhatsApp outbound job retained by safety middleware');
      throw new WhatsAppOutboundHeldError(job.id, reason);
    }

    if (decision.delayMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, decision.delayMs));
    }

    try {
      const sent = await this.rawSocket.sendMessage(chatJid, content, options);
      const sentAt = nowSeconds();
      const terminalContentJson = terminalMediaContentJson(content, kind);
      if (terminalContentJson) {
        await updateWhatsAppOutboundJob(job.id, 'sent', null, sentAt, terminalContentJson);
      } else {
        await updateWhatsAppOutboundJob(job.id, 'sent', null, sentAt);
      }
      this.antiBan.afterSend(chatJid, decisionText(content));
      return sent;
    } catch (err) {
      const message = errorText(err);
      this.antiBan.afterSendFailed(message);
      const terminalContentJson = terminalMediaContentJson(content, kind);
      if (terminalContentJson) {
        await updateWhatsAppOutboundJob(job.id, 'failed', message, undefined, terminalContentJson);
      } else {
        await updateWhatsAppOutboundJob(job.id, 'failed', message);
      }
      throw err;
    }
  }

  async sendControlText(chatJid: string, text: string): Promise<SendResult> {
    return this.rawSocket.sendMessage(chatJid, { text });
  }

  async pause(): Promise<void> {
    await this.initialized;
    const state = await getWhatsAppSafetyState();
    this.antiBan.pause();
    await setWhatsAppSafetyState(true, state.risk, state.score, state.reasons);
  }

  async resume(): Promise<void> {
    await this.initialized;
    const state = await getWhatsAppSafetyState();
    this.antiBan.resume();
    await setWhatsAppSafetyState(false, state.risk, state.score, state.reasons);
  }

  async metrics(): Promise<WhatsAppSafetyMetrics> {
    const now = nowSeconds();
    return getWhatsAppSafetyMetrics(now - HOUR_SECONDS, now - DAY_SECONDS);
  }

  async heldJobs(limit: number = 10): Promise<WhatsAppOutboundJob[]> {
    return listWhatsAppHeldJobs(limit);
  }

  async releaseHeldJob(id: number): Promise<boolean> {
    const job = await getWhatsAppOutboundJob(id);
    if (!job || job.status !== 'held') return false;

    try {
      const content = parsePayload<SendContent>(job.contentJson);
      if (!content) return false;
      const options = parsePayload<SendOptions>(job.optionsJson);
      await this.rawSocket.sendMessage(job.chatJid, content, options);
      const terminalContentJson = terminalMediaContentJson(content, job.kind);
      if (terminalContentJson) {
        await updateWhatsAppOutboundJob(
          job.id,
          'sent',
          'Released manually by owner',
          nowSeconds(),
          terminalContentJson,
        );
      } else {
        await updateWhatsAppOutboundJob(job.id, 'sent', 'Released manually by owner', nowSeconds());
      }
      logger.info({ jobId: job.id, kind: job.kind }, 'Released retained WhatsApp outbound job');
      return true;
    } catch (err) {
      await updateWhatsAppOutboundJob(job.id, 'held', `Manual release failed: ${errorText(err)}`);
      logger.error({ err, jobId: job.id, kind: job.kind }, 'Failed to release retained WhatsApp outbound job');
      return false;
    }
  }

  async discardHeldJob(id: number): Promise<boolean> {
    const job = await getWhatsAppOutboundJob(id);
    if (!job || job.status !== 'held') return false;
    return updateWhatsAppOutboundJob(id, 'discarded', 'Discarded manually by owner');
  }

  onIncomingMessage(chatJid: string, text?: string): void {
    this.antiBan.onIncomingMessage(chatJid, text);
  }

  onConnected(): void {
    this.antiBan.onReconnect();
  }

  onDisconnected(statusCode: number): void {
    this.antiBan.onDisconnect(statusCode);
  }

  destroy(): void {
    this.antiBan.destroy();
  }
}

const dispatcherBySocket = new WeakMap<WASocket, WhatsAppOutboundSafety>();

export function createProtectedWhatsAppSocket(rawSocket: WASocket): WASocket {
  const safety = new WhatsAppOutboundSafety(rawSocket);
  const protectedSocket = new Proxy(rawSocket, {
    get(target, property, receiver) {
      if (property === 'sendMessage') {
        return safety.sendMessage.bind(safety);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as WASocket;
  dispatcherBySocket.set(protectedSocket, safety);
  return protectedSocket;
}

export function getWhatsAppOutboundSafety(sock: WASocket): WhatsAppOutboundSafety | undefined {
  return dispatcherBySocket.get(sock);
}
