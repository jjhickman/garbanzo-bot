import type { MessagingPlatform } from './messaging-platform.js';

/**
 * Cross-platform message reference.
 *
 * Core treats `ref` as opaque, but the wrapper shape is stable so we can:
 * - prevent accidentally mixing reply/delete refs across platforms
 * - keep basic metadata (`chatId`, `id`) available for logging and tests
 */
export interface MessageRef {
  platform: MessagingPlatform;
  chatId: string;

  /** Best-effort message id (platform-native when available). */
  id: string;

  /** Platform-native reference object for adapters (opaque to core). */
  ref: unknown;
}

export function createMessageRef(params: {
  platform: MessagingPlatform;
  chatId: string;
  id: string;
  ref: unknown;
}): MessageRef {
  return {
    platform: params.platform,
    chatId: params.chatId,
    id: params.id,
    ref: params.ref,
  };
}

export function isMessageRef(value: unknown): value is MessageRef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.platform === 'string'
    && typeof v.chatId === 'string'
    && typeof v.id === 'string'
    && 'ref' in v;
}
