export type { MessagingPlatform } from '../core/messaging-platform.js';
import type { PlatformMessenger } from '../core/platform-messenger.js';

export interface PlatformRuntime {
  platform: import('../core/messaging-platform.js').MessagingPlatform;
  start(): Promise<void>;
  stop(): Promise<void>;

  /**
   * The current outbound messenger, when the runtime is connected — used by
   * the bridge lifecycle (`src/bridge/lifecycle.ts`) to deliver relays.
   * Returns null before connect and (for WhatsApp) between reconnects; the
   * bridge reads this lazily at send time rather than snapshotting it.
   * Runtimes that do not support bridging (Slack/Teams scaffolds) may omit
   * this method entirely.
   */
  getMessenger?(): PlatformMessenger | null;
}
