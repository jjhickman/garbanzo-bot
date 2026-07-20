import { logger } from '../../middleware/logger.js';
import { fetchBoundedBuffer, MEDIA_FETCH_TIMEOUT_MS } from '../../utils/bounded-fetch.js';

const TELEGRAM_VOICE_MAX_BYTES = 20 * 1024 * 1024;

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

/**
 * Scrub a bot token out of arbitrary text before logging. Exported (F9, T2
 * review) so every Telegram module that logs a raw HTTP response body/error
 * — not just this one — reuses the SAME defense rather than forking it;
 * see telegram-owner.ts.
 */
export function redactToken(message: string, token: string): string {
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEDIA_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchFn(
      `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
      { signal: controller.signal },
    );
    if (!response.ok) return null;
    const json = await response.json() as TelegramGetFileResponse;
    if (!json.ok) return null;
    return json.result?.file_path ?? null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Download a Telegram voice message's bytes. Returns null (never throws) on
 * any failure — the caller degrades gracefully (InboundMessage.audio.buffer
 * stays undefined; downstream consumers still get contentType + a safe
 * file_id-based placeholder url).
 */
export async function downloadTelegramFile(
  token: string,
  fileId: string,
  maxBytes: number,
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
    return await fetchBoundedBuffer(fileUrl, {
      fetchFn,
      maxBytes,
      onFailure: (failure) => {
        if (failure.reason === 'error') {
          const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
          logger.warn({ err: redactToken(message, token), fileId }, 'Telegram file download threw');
        } else {
          logger.warn(
            { fileId, ...(failure.reason === 'status' ? { status: failure.status } : {}) },
            'Telegram file download failed',
          );
        }
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: redactToken(message, token), fileId }, 'Telegram file download threw');
    return null;
  }
}

export async function downloadTelegramVoice(
  token: string,
  fileId: string,
  deps: { fetchFn?: typeof fetch; maxBytes?: number } = {},
): Promise<Buffer | null> {
  return downloadTelegramFile(token, fileId, deps.maxBytes ?? TELEGRAM_VOICE_MAX_BYTES, deps);
}
