import type { BridgeEnvelope } from './envelope.js';

export type InboundBridgeResult = 'accepted' | 'duplicate';

export interface BridgeTransport {
  deliver(envelope: BridgeEnvelope, targetUrl: string | null): Promise<void>;
  startInbound(handler: (env: BridgeEnvelope) => Promise<InboundBridgeResult>): Promise<void>;
  stop(): Promise<void>;
}

export class TransportDeliveryError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransportDeliveryError';
    this.retryable = retryable;
  }
}

export class BridgeDeliveryDeferredError extends Error {
  readonly retryAtMs: number;

  constructor(retryAtMs: number, message?: string, options?: ErrorOptions) {
    super(message ?? `Bridge delivery deferred until ${retryAtMs}`, options);
    this.name = 'BridgeDeliveryDeferredError';
    this.retryAtMs = retryAtMs;
  }
}
