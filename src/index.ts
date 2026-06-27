import { closeDb, scheduleMaintenance } from './utils/db.js';
import { getPlatformRuntime } from './platforms/index.js';
import { logger } from './middleware/logger.js';
import { config } from './utils/config.js';
import { startHealthServer, stopHealthServer, startMemoryWatchdog } from './middleware/health.js';
import { clearRetryQueue } from './middleware/retry.js';
import { startOllamaWarmup, stopOllamaWarmup } from './ai/ollama.js';
import type { PlatformRuntime } from './platforms/types.js';

let activeRuntime: PlatformRuntime | null = null;

const SHUTDOWN_TIMEOUT_MS = 10_000;
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | void> {
  return Promise.race([
    p,
    new Promise<void>((resolve) => setTimeout(() => { logger.warn({ label, ms }, 'Shutdown step timed out'); resolve(); }, ms).unref?.()),
  ]);
}

async function main(): Promise<void> {
  logger.info('🫘 Garbanzo starting...');

  const healthOnlyMode = process.env.HEALTH_ONLY?.toLowerCase() === 'true';

  // Platform runtime selection

  const cloudProviders: string[] = [];
  if (config.OPENROUTER_API_KEY) cloudProviders.push('openrouter');
  if (config.ANTHROPIC_API_KEY) cloudProviders.push('anthropic');
  if (config.OPENAI_API_KEY) cloudProviders.push('openai');
  if (config.GEMINI_API_KEY) cloudProviders.push('gemini');
  if (config.BEDROCK_MODEL_ID) cloudProviders.push('bedrock');

  logger.info({
    cloudProviders,
    messagingPlatform: config.MESSAGING_PLATFORM,
    healthOnlyMode,
    healthPort: config.HEALTH_PORT,
    healthBindHost: config.HEALTH_BIND_HOST,
    ollamaUrl: config.OLLAMA_BASE_URL,
    logLevel: config.LOG_LEVEL,
  }, 'Configuration loaded');

  // Start health check server + memory watchdog for monitoring
  startHealthServer(config.HEALTH_PORT, config.HEALTH_BIND_HOST, { metricsEnabled: config.METRICS_ENABLED });
  startMemoryWatchdog();

  // Start Ollama warm-up pings to prevent model unloading
  startOllamaWarmup();

  // Schedule daily database maintenance (prune old messages + VACUUM at 4 AM)
  scheduleMaintenance();

  if (healthOnlyMode) {
    logger.warn('HEALTH_ONLY=true enabled — skipping WhatsApp connection for smoke test mode');
    return;
  }

  const runtime = getPlatformRuntime();
  activeRuntime = runtime;
  logger.info({ platform: runtime.platform }, 'Starting platform runtime');
  await runtime.start();
  logger.info('🫘 Garbanzo Bean is online and listening');
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
async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  logger.info({ signal }, 'Received shutdown signal — shutting down');
  clearRetryQueue();
  stopOllamaWarmup();
  stopHealthServer();

  if (activeRuntime) {
    try {
      await withTimeout(activeRuntime.stop(), SHUTDOWN_TIMEOUT_MS, 'runtime.stop');
    } catch (err) {
      logger.error({ err, signal }, 'Runtime stop failed during shutdown');
    }
  }

  try {
    await withTimeout(closeDb(), SHUTDOWN_TIMEOUT_MS, 'closeDb');
  } catch (err) {
    logger.error({ err, signal }, 'Failed to close database cleanly during shutdown');
  }

  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
