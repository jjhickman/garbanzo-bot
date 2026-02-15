export type { MessagingPlatform } from '../core/messaging-platform.js';

export interface PlatformRuntime {
  platform: import('../core/messaging-platform.js').MessagingPlatform;
  start(): Promise<void>;
}
