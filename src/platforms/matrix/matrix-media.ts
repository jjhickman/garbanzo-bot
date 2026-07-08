import { logger } from '../../middleware/logger.js';

export interface MatrixMediaClient {
  downloadContent?(mxcUrl: string): Promise<Buffer | Uint8Array | ArrayBuffer>;
}

export function redactToken(message: string, token: string): string {
  return token ? message.split(token).join('[redacted]') : message;
}

export async function downloadMatrixAudio(
  client: MatrixMediaClient,
  accessToken: string,
  mxcUrl: string,
): Promise<Buffer | null> {
  try {
    if (!client.downloadContent) {
      logger.warn({ mxcUrl }, 'Matrix media client does not expose downloadContent');
      return null;
    }

    const data = await client.downloadContent(mxcUrl);
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof Uint8Array) return Buffer.from(data);
    return Buffer.from(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: redactToken(message, accessToken), mxcUrl }, 'Matrix audio download threw');
    return null;
  }
}
