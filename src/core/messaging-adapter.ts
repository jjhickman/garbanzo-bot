import type { MessagingPlatform } from './messaging-platform.js';

/**
 * Messaging adapter API.
 *
 * This is the minimal surface needed to send responses without exposing
 * platform-specific SDK types to core routing.
 */
export interface MessagingAdapter {
  platform: MessagingPlatform;

  sendText(chatId: string, text: string, options?: { replyTo?: unknown }): Promise<void>;
}
