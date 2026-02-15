import { startConnection } from './bot/connection.js';
import { registerHandlers } from './bot/handlers.js';
import { registerIntroCatchUp } from './features/introductions.js';
import { scheduleDigest } from './features/digest.js';
import { closeDb, scheduleMaintenance } from './utils/db.js';
import { logger } from './middleware/logger.js';
import { config } from './utils/config.js';
import { startHealthServer, stopHealthServer, startMemoryWatchdog } from './middleware/health.js';
import { clearRetryQueue } from './middleware/retry.js';
import { startOllamaWarmup, stopOllamaWarmup } from './ai/ollama.js';

async function main(): Promise<void> {
  logger.info('🫘 Garbanzo starting...');

  const healthOnlyMode = process.env.HEALTH_ONLY?.toLowerCase() === 'true';

  if (config.MESSAGING_PLATFORM !== 'whatsapp') {
    logger.fatal({
      messagingPlatform: config.MESSAGING_PLATFORM,
      supported: ['whatsapp'],
    }, 'Selected messaging platform is not implemented yet');
    process.exit(1);
  }

  const cloudProviders: string[] = [];
  if (config.OPENROUTER_API_KEY) cloudProviders.push('openrouter');
  if (config.ANTHROPIC_API_KEY) cloudProviders.push('anthropic');
  if (config.OPENAI_API_KEY) cloudProviders.push('openai');

  logger.info({
    cloudProviders,
    messagingPlatform: config.MESSAGING_PLATFORM,
    healthOnlyMode,
    ollamaUrl: config.OLLAMA_BASE_URL,
    logLevel: config.LOG_LEVEL,
  }, 'Configuration loaded');

  // Start health check server + memory watchdog for monitoring
  startHealthServer();
  startMemoryWatchdog();

  // Start Ollama warm-up pings to prevent model unloading
  startOllamaWarmup();

  // Schedule daily database maintenance (prune old messages + VACUUM at 4 AM)
  scheduleMaintenance();

  if (healthOnlyMode) {
    logger.warn('HEALTH_ONLY=true enabled — skipping WhatsApp connection for smoke test mode');
    return;
  }

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

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection — bot shutting down');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — bot shutting down');
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT — shutting down');
  clearRetryQueue();
  stopOllamaWarmup();
  stopHealthServer();
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM — shutting down');
  clearRetryQueue();
  stopOllamaWarmup();
  stopHealthServer();
  closeDb();
  process.exit(0);
});
