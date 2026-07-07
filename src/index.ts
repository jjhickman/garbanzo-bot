import { randomBytes } from 'crypto';
import { closeDb, scheduleMaintenance } from './utils/db.js';
import { getPlatformRuntime } from './platforms/index.js';
import { logger } from './middleware/logger.js';
import { config, loadedEnvFiles } from './utils/config.js';
import { startHealthServer, stopHealthServer, startMemoryWatchdog } from './middleware/health.js';
import { clearRetryQueue } from './middleware/retry.js';
import { startOllamaWarmup, stopOllamaWarmup } from './ai/ollama.js';
import { getPersonaName } from './ai/persona.js';
import { createLoginRequestHandler } from './platforms/whatsapp/login-server.js';
import { isNetworkExposedHost, resolveLoginHosts, shouldEnableWhatsAppLogin } from './platforms/whatsapp/login-url.js';
import type { PlatformRuntime } from './platforms/types.js';

let activeRuntime: PlatformRuntime | null = null;
let activeBridgeStop: (() => Promise<void>) | null = null;

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
    envFiles: loadedEnvFiles,
  }, 'Configuration loaded');

  const monitoringToken = config.MONITORING_TOKEN ?? randomBytes(24).toString('hex');
  const loginToken = config.WHATSAPP_LOGIN_TOKEN ?? randomBytes(24).toString('hex');
  const whatsAppLoginEnabled = shouldEnableWhatsAppLogin(
    config.MESSAGING_PLATFORM,
    config.WHATSAPP_LOGIN_MODE,
    healthOnlyMode,
  );
  const loginHandler = whatsAppLoginEnabled ? createLoginRequestHandler({ token: loginToken }) : undefined;

  if ((config.METRICS_ENABLED || config.ADMIN_PAGE_ENABLED) && !config.MONITORING_TOKEN) {
    logger.info(
      'Ops endpoints are gated by a per-run token; pin MONITORING_TOKEN in .env to enable scraping/admin access.',
    );
  }

  // Construct (but do not yet start) the platform runtime — the bridge
  // lifecycle needs it to resolve the outbound messenger lazily, and
  // constructing a runtime has no side effects until start() is called.
  const runtime = getPlatformRuntime();
  activeRuntime = runtime;

  // Start health check server + memory watchdog for monitoring
  const healthOptions: Parameters<typeof startHealthServer>[2] = {
    metricsEnabled: config.METRICS_ENABLED,
    adminEnabled: config.ADMIN_PAGE_ENABLED,
    authToken: monitoringToken,
    extraHandler: loginHandler,
  };
  if (config.BRIDGE_ENABLED) {
    // Dynamic import: deployments that don't enable the bridge (the vast
    // majority) never load amqplib or the bridge module graph at all.
    const { startBridge } = await import('./bridge/lifecycle.js');
    const bridge = await startBridge({
      getMessenger: () => runtime.getMessenger?.() ?? null,
    });
    if (bridge) {
      healthOptions.bridgeInboundHandler = bridge.handler;
      activeBridgeStop = bridge.stop;
      logger.info({ instanceId: config.INSTANCE_ID ?? config.MESSAGING_PLATFORM }, 'Bridge lifecycle started');
    }
  }
  startHealthServer(config.HEALTH_PORT, config.HEALTH_BIND_HOST, healthOptions);
  startMemoryWatchdog();

  if (whatsAppLoginEnabled) {
    // A wildcard bind (0.0.0.0/::) listens on every interface, so surface the
    // machine's LAN address(es) a remote browser can actually reach — e.g. when
    // garbanzo runs on a Raspberry Pi and you link from a laptop on the network.
    const baseUrls = resolveLoginHosts(config.HEALTH_BIND_HOST).map(
      (host) => `http://${host}:${config.HEALTH_PORT}/whatsapp/login`,
    );

    if (isNetworkExposedHost(config.HEALTH_BIND_HOST)) {
      logger.warn(
        { bindHost: config.HEALTH_BIND_HOST },
        'WhatsApp login is exposed on the network; it is protected only by the login token over plaintext HTTP — prefer a trusted network or an SSH tunnel (ssh -L)',
      );
    }

    if (config.WHATSAPP_LOGIN_TOKEN) {
      // The operator supplied the token — never echo their secret into the logs.
      logger.info(
        { urls: baseUrls },
        'WhatsApp browser login available; append ?token=<your WHATSAPP_LOGIN_TOKEN> if WhatsApp needs linking',
      );
    } else {
      // Token was generated for this run and has no other delivery channel — surface it once.
      logger.info(
        { urls: baseUrls.map((url) => `${url}?token=${loginToken}`) },
        'WhatsApp browser login available; open a URL if WhatsApp needs linking (token generated for this run)',
      );
    }
  }

  // Start Ollama warm-up pings to prevent model unloading
  startOllamaWarmup();

  // Schedule daily database maintenance (prune old messages + VACUUM at 4 AM)
  scheduleMaintenance();

  if (healthOnlyMode) {
    logger.warn('HEALTH_ONLY=true enabled — skipping WhatsApp connection for smoke test mode');
    return;
  }

  logger.info({ platform: runtime.platform }, 'Starting platform runtime');
  await runtime.start();
  logger.info(`${getPersonaName()} is online and listening`);
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

  if (activeBridgeStop) {
    try {
      await withTimeout(activeBridgeStop(), SHUTDOWN_TIMEOUT_MS, 'bridge.stop');
    } catch (err) {
      logger.error({ err, signal }, 'Bridge stop failed during shutdown');
    }
  }

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
