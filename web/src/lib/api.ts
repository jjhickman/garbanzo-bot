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

export interface ConfigBundle {
  format: 'garbanzo-config-bundle-v1';
  files: Record<string, string>;
}

export interface ImportPreview {
  stagingId: string;
  diff: Record<string, string>;
}

export interface ImportResult {
  ok: true;
  changed: string[];
}

export interface ApplyResult {
  text: string;
  exitCode: number | null;
  guidance?: string;
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

function expireSession(): void {
  clearSession();
  expiryListeners.forEach((listener) => listener());
}

function apiError(response: Response, body: unknown): ApiError {
  const message = typeof body === 'object' && body && 'error' in body
    ? String((body as { error: unknown }).error)
    : `Request failed (${response.status})`;
  return new ApiError(message, response.status, body);
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
    expireSession();
  }
  if (!response.ok) throw apiError(response, body);
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
export const validate = validateConfig;
export const exportBundle = (): Promise<ConfigBundle> => authenticated('/api/export');
export const exportConfig = exportBundle;

export function importBundle(fileOrBundle: File | ConfigBundle): Promise<ImportPreview> {
  if (typeof File !== 'undefined' && fileOrBundle instanceof File) {
    const form = new FormData();
    form.append('file', fileOrBundle);
    return authenticated('/api/import', { method: 'POST', body: form });
  }
  return authenticated('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fileOrBundle),
  });
}

export const importConfig = (body: unknown): Promise<unknown> => authenticated('/api/import', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const confirmImport = (stagingId: string): Promise<ImportResult> => authenticated('/api/import', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ confirm: true, stagingId }),
});
export const getWizardSchema = (): Promise<WizardSchema> => authenticated('/api/wizard/schema');
export const submitWizard = (fields: Record<string, string>, args: string[] = []): Promise<WizardResult> => authenticated('/api/wizard', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields, ...(args.length ? { args } : {}) }),
});
export const runWizard = (args: string[]): Promise<unknown> => authenticated('/api/wizard', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args }),
});

export async function applyStream(onChunk: (chunk: string) => void): Promise<ApplyResult> {
  if (!sessionToken) throw new ApiError('Authentication required', 401, null);
  const response = await fetch('/api/apply', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok) {
    const body = await responseBody(response);
    if (response.status === 401) expireSession();
    throw apiError(response, body);
  }
  if (contentType.includes('application/json')) {
    const body = await response.json() as { guidance?: unknown };
    const guidance = typeof body.guidance === 'string' ? body.guidance : 'Configuration accepted. Restart Garbanzo to apply it.';
    onChunk(`${guidance}\n`);
    clearSession();
    return { text: `${guidance}\n`, exitCode: null, guidance };
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text) onChunk(text);
    const exitCode = Number(text.match(/(?:^|\n)exit (\d+)\s*$/)?.[1] ?? Number.NaN);
    if (exitCode === 0) clearSession();
    return { text, exitCode: Number.isNaN(exitCode) ? null : exitCode };
  }
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    text += chunk;
    onChunk(chunk);
  }
  const tail = decoder.decode();
  if (tail) {
    text += tail;
    onChunk(tail);
  }
  const match = text.match(/(?:^|\n)exit (\d+)\s*$/);
  const exitCode = match ? Number(match[1]) : null;
  if (exitCode === 0) clearSession();
  return { text, exitCode };
}

export const applyConfig = (): Promise<unknown> => authenticated('/api/apply', { method: 'POST' });
