import type { MessagingAdapter } from '../../core/messaging-adapter.js';
import type { MessageRef } from '../../core/message-ref.js';
import type { PollPayload } from '../../core/poll-payload.js';
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

    async sendPoll(_chatId: string, _poll: PollPayload): Promise<void> {
      throw err();
    },

    async sendTextWithRef(): Promise<MessageRef> {
      throw err();
    },

    async sendDocument(_chatId: string, _doc: DocumentPayload): Promise<MessageRef> {
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
