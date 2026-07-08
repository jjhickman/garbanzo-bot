import { getTelegramChatName } from './telegram-config.js';

interface BuildTelegramWelcomeMessageInput {
  chatId: string;
  memberUserId: string;
  memberDisplayName?: string;
}

export function buildTelegramWelcomeMessage(input: BuildTelegramWelcomeMessageInput): string {
  const chatName = getTelegramChatName(input.chatId);
  const destination = chatName ?? 'the group';
  const who = input.memberDisplayName ?? `user ${input.memberUserId}`;

  return `Welcome ${who} to ${destination}! Glad you're here - jump in when you're ready.`;
}
