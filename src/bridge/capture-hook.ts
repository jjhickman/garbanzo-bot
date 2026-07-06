import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import type { InboundMessage } from '../core/inbound-message.js';

/**
 * Bridge-agnostic-safe entry point for platform processors.
 *
 * Platform processors (whatsapp/discord/slack `processor.ts`) wire this in
 * as `hooks.captureForBridge` unconditionally, but it only loads the bridge
 * lifecycle module graph — `lifecycle.ts`, `bridge-map.ts`, the transports
 * (including the `amqplib` dependency) — the first time it is actually
 * called AND `BRIDGE_ENABLED` is true. Deployments that never enable the
 * bridge (the default, and almost every test) pay zero cost and never risk
 * tripping over bridge-only config fields.
 */
export function captureForBridge(inbound: InboundMessage): void {
  if (!config.BRIDGE_ENABLED) return;

  void import('./lifecycle.js')
    .then(({ getCaptureForBridge }) => getCaptureForBridge()?.(inbound))
    .catch((err) => {
      logger.error({ err }, 'Bridge capture hook: lazy load of the bridge lifecycle module failed');
    });
}
