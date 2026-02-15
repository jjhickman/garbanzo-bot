import type { MessagingPlatform } from './messaging-platform.js';
import type { MessageRef } from './message-ref.js';

/**
 * Messaging adapter API.
 *
 * This is the minimal surface needed to send responses without exposing
 * platform-specific SDK types to core routing.
 */
export interface MessagingAdapter {
  platform: MessagingPlatform;

  sendText(chatId: string, text: string, options?: { replyTo?: MessageRef }): Promise<void>;
}
