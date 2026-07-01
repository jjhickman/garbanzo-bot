export type DemoPlatform = 'slack' | 'discord';

export interface SlackDemoServerOptions {
  turnstileEnabled?: boolean;
  turnstileSiteKey?: string;
  verifyTurnstile?: (token: string, clientIp: string) => Promise<boolean>;
}

export interface DemoModelConfig {
  providerOrder: string[];
  primaryProvider: string;
  primaryModel: string;
  modelsByProvider: Record<string, string>;
  costProfile: string;
}
