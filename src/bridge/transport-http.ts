import { config } from '../utils/config.js';
import type { BridgeEnvelope } from './envelope.js';
import { BridgeDeliveryDeferredError, TransportDeliveryError, type BridgeTransport } from './transport.js';

const DELIVERY_TIMEOUT_MS = 10_000;

function monitoringToken(): string {
  return config.MONITORING_TOKEN ?? process.env.MONITORING_TOKEN ?? '';
}

export function createHttpBridgeTransport(): BridgeTransport {
  return {
    async deliver(envelope: BridgeEnvelope, targetUrl: string | null): Promise<void> {
      if (!targetUrl) {
        throw new TransportDeliveryError('Bridge HTTP target URL is missing', false);
      }

      let response: Response;
      try {
        response = await fetch(`${targetUrl.replace(/\/+$/, '')}/bridge/inbound`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${monitoringToken()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });
      } catch (err) {
        throw new TransportDeliveryError('Bridge HTTP delivery failed before response', true, {
          cause: err,
        });
      }

      if (response.ok) return;

      const deferred = await parseBridgeDeferral(response);
      if (deferred) throw deferred;

      if (response.status === 400 || response.status === 401) {
        throw new TransportDeliveryError(`Bridge HTTP delivery rejected with ${response.status}`, false);
      }

      throw new TransportDeliveryError(`Bridge HTTP delivery failed with ${response.status}`, true);
    },

    async startInbound(): Promise<void> {
      // Inbound HTTP receiving is mounted by the health server in Task 5.
    },

    async stop(): Promise<void> {
      // No persistent resources for fetch-based delivery.
    },
  };
}

async function parseBridgeDeferral(response: Response): Promise<BridgeDeliveryDeferredError | null> {
  if (response.status !== 429) return null;

  let body: unknown;
  try {
    body = JSON.parse(await response.text()) as unknown;
  } catch {
    return null;
  }

  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record.error !== 'delivery deferred') return null;
  const retryAtMs = record.retryAtMs;
  if (typeof retryAtMs !== 'number' || !Number.isFinite(retryAtMs)) return null;
  return new BridgeDeliveryDeferredError(retryAtMs);
}
