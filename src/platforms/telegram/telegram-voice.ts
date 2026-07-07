import { logger } from '../../middleware/logger.js';

/**
 * CREDENTIAL RULE (plan-critical, review-mandated): Telegram file URLs are
 * shaped `https://api.telegram.org/file/bot<TOKEN>/<file_path>` — they embed
 * the bot token in plain text. This module downloads the bytes immediately
 * via getFile and returns a Buffer; the token-bearing URL lives only in a
 * local variable inside this function and MUST NEVER be logged, returned, or
 * attached to InboundMessage/persisted data. Callers get a Buffer (or null
 * on failure) — never a URL. As defense in depth, any error text is scrubbed
 * of the token before logging.
 */

function redactToken(message: string, token: string): string {
  return token ? message.split(token).join('[redacted]') : message;
}

interface TelegramGetFileResponse {
  ok?: boolean;
  result?: { file_path?: string };
}

async function fetchTelegramFilePath(
  token: string,
  fileId: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  const response = await fetchFn(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  if (!response.ok) return null;

  const json = await response.json() as TelegramGetFileResponse;
  if (!json.ok) return null;
  return json.result?.file_path ?? null;
}

/**
 * Download a Telegram voice message's bytes. Returns null (never throws) on
 * any failure — the caller degrades gracefully (InboundMessage.audio.buffer
 * stays undefined; downstream consumers still get contentType + a safe
 * file_id-based placeholder url).
 */
export async function downloadTelegramVoice(
  token: string,
  fileId: string,
  deps: { fetchFn?: typeof fetch } = {},
): Promise<Buffer | null> {
  const fetchFn = deps.fetchFn ?? fetch;

  try {
    const filePath = await fetchTelegramFilePath(token, fileId, fetchFn);
    if (!filePath) {
      logger.warn({ fileId }, 'Telegram getFile did not return a usable file path');
      return null;
    }

    // Token-bearing URL — local only. Never logged, returned, or persisted.
    const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const fileResponse = await fetchFn(fileUrl);
    if (!fileResponse.ok) {
      logger.warn({ fileId, status: fileResponse.status }, 'Telegram voice file download failed');
      return null;
    }

    const arrayBuffer = await fileResponse.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: redactToken(message, token), fileId }, 'Telegram voice download threw');
    return null;
  }
}
