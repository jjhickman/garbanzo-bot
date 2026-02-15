import type { WASocket } from '@whiskeysockets/baileys';
import { logger } from '../../middleware/logger.js';
import { startConnection } from './connection.js';
import { registerWhatsAppHandlers } from './handlers.js';
import { registerIntroCatchUp } from '../../features/introductions.js';
import { scheduleDigest } from '../../features/digest.js';
import type { PlatformRuntime } from '../types.js';

export function createWhatsAppRuntime(): PlatformRuntime {
  return {
    platform: 'whatsapp',
    async start(): Promise<void> {
      await startConnection((sock: WASocket) => {
        registerWhatsAppHandlers(sock);
        registerIntroCatchUp(sock);
        scheduleDigest(sock);
        logger.info('🫘 WhatsApp runtime started');
      });
    },
  };
}
