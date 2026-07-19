import { logger } from '../../middleware/logger.js';

export interface MatrixMediaClient {
  downloadContent?(mxcUrl: string): Promise<
    Buffer | Uint8Array | ArrayBuffer | { data: Buffer | Uint8Array | ArrayBuffer; contentType?: string }
  >;
}

const MATRIX_MEDIA_TIMEOUT_MS = 15_000;
const MATRIX_AUDIO_MAX_BYTES = 20 * 1024 * 1024;

export function redactToken(message: string, token: string): string {
  return token ? message.split(token).join('[redacted]') : message;
}

export async function downloadMatrixMedia(
  client: MatrixMediaClient,
  accessToken: string,
  mxcUrl: string,
  maxBytes: number,
): Promise<Buffer | null> {
  try {
    if (!client.downloadContent) {
      logger.warn({ mxcUrl }, 'Matrix media client does not expose downloadContent');
      return null;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), MATRIX_MEDIA_TIMEOUT_MS);
      timer.unref();
    });
    const downloaded = await Promise.race([client.downloadContent(mxcUrl), timeout]);
    if (timer) clearTimeout(timer);
    if (!downloaded) return null;
    const data = typeof downloaded === 'object' && 'data' in downloaded
      ? downloaded.data
      : downloaded;
    const buffer = Buffer.isBuffer(data)
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(new Uint8Array(data))
        : Buffer.from(data);
    return buffer.byteLength <= maxBytes ? buffer : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: redactToken(message, accessToken), mxcUrl }, 'Matrix media download threw');
    return null;
  }
}

export async function downloadMatrixAudio(
  client: MatrixMediaClient,
  accessToken: string,
  mxcUrl: string,
  maxBytes: number = MATRIX_AUDIO_MAX_BYTES,
): Promise<Buffer | null> {
  return downloadMatrixMedia(client, accessToken, mxcUrl, maxBytes);
}
