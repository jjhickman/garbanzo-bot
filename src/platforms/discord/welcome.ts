import { getDiscordChannelName } from './discord-config.js';

interface BuildDiscordWelcomeMessageInput {
  channelId: string;
  memberUserId: string;
  memberDisplayName?: string;
}

export function buildDiscordWelcomeMessage(input: BuildDiscordWelcomeMessageInput): string {
  const channelName = getDiscordChannelName(input.channelId);
  const destination = channelName ? `#${channelName}` : 'the band Discord';

  return `Welcome <@${input.memberUserId}> to ${destination}. Glad you are here - jump in when you are ready.`;
}
