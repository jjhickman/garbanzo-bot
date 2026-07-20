/**
 * Minimal Discord REST helper shared by the adapter and the native-event
 * methods. Kept separate from adapter.ts so both can import it without a
 * cycle and so callers can branch on the HTTP status (e.g. 403 → missing
 * permission) instead of string-matching error text.
 */

export class DiscordApiError extends Error {
  constructor(
    public readonly status: number,
    path: string,
    body: string,
  ) {
    super(`Discord API ${path} failed (${status}): ${body}`);
    this.name = 'DiscordApiError';
  }
}

export async function discordApiRequest<T>(
  token: string,
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: {
      authorization: `Bot ${token}`,
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new DiscordApiError(response.status, path, text);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return await response.json() as T;
}
