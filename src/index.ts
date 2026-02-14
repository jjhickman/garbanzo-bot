import { startConnection } from './bot/connection.js';
import { registerHandlers } from './bot/handlers.js';
import { registerIntroCatchUp } from './features/introductions.js';
import { scheduleDigest } from './features/digest.js';
import { closeDb } from './utils/db.js';
import { logger } from './middleware/logger.js';
import { config } from './utils/config.js';

async function main(): Promise<void> {
  logger.info('🫘 Garbanzo Bot starting...');
  logger.info({
    aiProvider: config.OPENROUTER_API_KEY ? 'openrouter' : 'anthropic',
    ollamaUrl: config.OLLAMA_BASE_URL,
    logLevel: config.LOG_LEVEL,
  }, 'Configuration loaded');

  await startConnection((sock) => {
    registerHandlers(sock);
    registerIntroCatchUp(sock);
    scheduleDigest(sock);
    logger.info('🫘 Garbanzo Bean is online and listening');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error — bot shutting down');
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT — shutting down');
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM — shutting down');
  closeDb();
  process.exit(0);
});
