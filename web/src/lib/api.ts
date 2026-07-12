export type DeploymentShape = 'compose' | 'package-repo' | 'bare';
export type SecretPlaceholder = { set: true };
export type EnvValue = string | SecretPlaceholder;

export interface ConfigState {
  root: string;
  shape: DeploymentShape;
  composeFiles: string[];
  packageRepo: boolean;
  platform: string | null;
  instanceId: string | null;
  platforms: string[];
  envFiles: Record<string, boolean>;
  configFiles: Record<string, boolean>;
}

export interface ConfigSnapshot {
  mtimeMs: number;
  fileMtimes: Record<string, number | null>;
  fileHashes: Record<string, string | null>;
  env: Record<string, EnvValue>;
  files: Record<string, { value: unknown; mtimeMs: number } | null>;
}

export interface ConfigUpdate {
  mtimeMs: number;
  fileMtimes: Record<string, number | null>;
  fileHashes: Record<string, string | null>;
  update: Record<string, string | null>;
}

export interface WizardField {
  env: string;
  cli: string;
  default: string;
  secret: boolean;
  note?: string;
}

export interface WizardSchema {
  platforms: string[];
  defaultPlatform: string;
  deployTargets: string[];
  providers: string[];
  vectorStores: string[];
  openaiAuthModes: string[];
  whatsappLoginModes: string[];
  chatScopes: string[];
  groups: {
    shared: WizardField[];
    whatsapp: WizardField[];
    discord: WizardField[];
    telegram: WizardField[];
    matrix: WizardField[];
  };
}

export interface WizardResult {
  ok: true;
  written: string[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let sessionToken: string | null = null;
const expiryListeners = new Set<() => void>();

export function hasSession(): boolean {
  return sessionToken !== null;
}

export function clearSession(): void {
  sessionToken = null;
}

export function onSessionExpired(listener: () => void): () => void {
  expiryListeners.add(listener);
  return () => expiryListeners.delete(listener);
}

async function responseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return response.json();
  return response.text();
}

async function authenticated<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!sessionToken) throw new ApiError('Authentication required', 401, null);
  const response = await fetch(path, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${sessionToken}`,
    },
  });
  const body = await responseBody(response);
  if (response.status === 401) {
    clearSession();
    expiryListeners.forEach((listener) => listener());
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body && 'error' in body
      ? String((body as { error: unknown }).error)
      : `Request failed (${response.status})`;
    throw new ApiError(message, response.status, body);
  }
  return body as T;
}

export async function exchangeEntryToken(entryToken: string): Promise<void> {
  clearSession();
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { Authorization: `Bearer ${entryToken}` },
  });
  const body = await responseBody(response);
  if (!response.ok || typeof body !== 'object' || !body || typeof (body as { token?: unknown }).token !== 'string') {
    throw new ApiError('The one-time token was not accepted.', response.status, body);
  }
  sessionToken = (body as { token: string }).token;
}

export const getState = (): Promise<ConfigState> => authenticated('/api/state');
export const getConfig = (): Promise<ConfigSnapshot> => authenticated('/api/config');
export const putConfig = (update: ConfigUpdate): Promise<{ ok: true; mtimeMs: number }> => authenticated('/api/config', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(update),
});
export const getConfigFile = <T = unknown>(name: string): Promise<T> => authenticated(`/api/config-file/${encodeURIComponent(name)}`);
export const putConfigFile = <T = unknown>(name: string, body: T): Promise<{ ok: true; mtimeMs: number }> => authenticated(`/api/config-file/${encodeURIComponent(name)}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
export const validateConfig = (body: unknown): Promise<{ ok: boolean; issues: unknown[] }> => authenticated('/api/validate', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
export const exportConfig = (): Promise<unknown> => authenticated('/api/export');
export const importConfig = (body: unknown): Promise<unknown> => authenticated('/api/import', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
export const getWizardSchema = (): Promise<WizardSchema> => authenticated('/api/wizard/schema');
export const submitWizard = (fields: Record<string, string>, args: string[] = []): Promise<WizardResult> => authenticated('/api/wizard', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields, ...(args.length ? { args } : {}) }),
});
export const runWizard = (args: string[]): Promise<unknown> => authenticated('/api/wizard', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args }),
});
export const applyConfig = (): Promise<unknown> => authenticated('/api/apply', { method: 'POST' });
