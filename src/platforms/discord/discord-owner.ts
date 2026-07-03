import { logger } from '../../middleware/logger.js';

interface DiscordDmChannelResponse {
  id?: unknown;
}

export async function resolveOwnerDmChannelId(
  token: string,
  ownerUserId: string,
  deps: { fetchFn?: typeof fetch } = {},
): Promise<string | null> {
  const fetchFn = deps.fetchFn ?? fetch;

  try {
    const response = await fetchFn('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        authorization: `Bot ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: ownerUserId }),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.warn({ status: response.status, error: text }, 'Discord owner DM channel resolution failed');
      return null;
    }

    const json = await response.json() as DiscordDmChannelResponse;
    if (typeof json.id !== 'string') {
      logger.warn({ response: json }, 'Discord owner DM channel response missing id');
      return null;
    }

    return json.id;
  } catch (err) {
    logger.warn({ err }, 'Discord owner DM channel resolution failed');
    return null;
  }
}
