import type { MessagingAdapter } from '../../core/messaging-adapter.js';
import type { PlatformMessenger, DocumentPayload, AudioPayload } from '../../core/platform-messenger.js';

/**
 * Slack adapter skeleton.
 *
 * This intentionally throws for all operations until the Slack runtime is implemented.
 * It exists to validate the platform/core boundaries at compile-time.
 */
export function createSlackAdapter(): PlatformMessenger {
  const err = () => new Error('Slack platform is not implemented');

  const adapter: PlatformMessenger = {
    platform: 'slack',

    async sendText(): Promise<void> {
      throw err();
    },

    async sendPoll(): Promise<void> {
      throw err();
    },

    async sendTextWithRef(): Promise<unknown> {
      throw err();
    },

    async sendDocument(_chatId: string, _doc: DocumentPayload): Promise<unknown> {
      throw err();
    },

    async sendAudio(_chatId: string, _audio: AudioPayload): Promise<void> {
      throw err();
    },

    async deleteMessage(): Promise<void> {
      throw err();
    },
  };

  // Ensure we still satisfy the minimal MessagingAdapter contract
  void (adapter satisfies MessagingAdapter);

  return adapter;
}
