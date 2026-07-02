import type { WASocket } from '@whiskeysockets/baileys';
import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import { startConnection } from './connection.js';
import { registerWhatsAppHandlers } from './handlers.js';
import { registerIntroCatchUp } from './introductions-catchup.js';
import { scheduleDigest } from './digest.js';
import { scheduleWeeklyRecap } from './recap.js';
import type { PlatformRuntime } from '../types.js';

export function createWhatsAppRuntime(): PlatformRuntime {
  let currentSock: WASocket | null = null;
  const disposers: Array<() => void> = [];

  function disposeAll(): void {
    for (const dispose of disposers.splice(0)) {
      try { dispose(); } catch (err) { logger.warn({ err }, 'WhatsApp registration dispose failed'); }
    }
  }

  return {
    platform: 'whatsapp',
    async start(): Promise<void> {
      await startConnection((sock: WASocket) => {
        // New connection generation: tear down the previous generation first.
        disposeAll();
        registerWhatsAppHandlers(sock);
        disposers.push(registerIntroCatchUp(sock));
        disposers.push(scheduleDigest(sock));
        if (config.WEEKLY_RECAP_ENABLED) disposers.push(scheduleWeeklyRecap(sock));
        logger.info('🫘 WhatsApp runtime started');
      }, () => disposeAll(), (sock) => {
        currentSock = sock;
      });
    },
    async stop(): Promise<void> {
      disposeAll();
      const sock = currentSock;
      currentSock = null;
      if (sock) {
        try { (sock.ev as unknown as { removeAllListeners(): void }).removeAllListeners(); } catch { /* best effort */ }
        try { sock.end(undefined); } catch { /* best effort */ }
      }
    },
  };
}
