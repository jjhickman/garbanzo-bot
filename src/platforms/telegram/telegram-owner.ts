import { logger } from '../../middleware/logger.js';

interface TelegramGetChatResponse {
  ok?: boolean;
  result?: { id?: number | string };
}

/**
 * Best-effort resolution of the owner's Telegram chat id, mirroring
 * discord-owner.ts's resolve-and-DM shape. Unlike Discord (which must create
 * a DM channel before it can message a user), a Telegram user id already IS
 * a valid chat_id for sendMessage — provided the user has started a chat
 * with the bot at least once. This calls getChat purely to confirm
 * reachability and log a clear warning when it is not yet reachable; the
 * raw configured id is always a safe fallback (see runtime.ts), so this
 * never blocks startup.
 */
export async function resolveOwnerChatId(
  token: string,
  ownerId: string,
  deps: { fetchFn?: typeof fetch } = {},
): Promise<string | null> {
  const fetchFn = deps.fetchFn ?? fetch;

  try {
    const response = await fetchFn(
      `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(ownerId)}`,
    );

    if (!response.ok) {
      const text = await response.text();
      logger.warn({ status: response.status, error: text }, 'Telegram owner chat resolution failed');
      return null;
    }

    const json = await response.json() as TelegramGetChatResponse;
    if (!json.ok || json.result?.id === undefined) {
      logger.warn({ response: json }, 'Telegram owner chat response missing id');
      return null;
    }

    return String(json.result.id);
  } catch (err) {
    logger.warn({ err }, 'Telegram owner chat resolution failed');
    return null;
  }
}
