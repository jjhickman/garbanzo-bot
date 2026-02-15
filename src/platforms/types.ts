export type MessagingPlatform = 'whatsapp' | 'discord' | 'slack' | 'teams';

export interface PlatformRuntime {
  platform: MessagingPlatform;
  start(): Promise<void>;
}
