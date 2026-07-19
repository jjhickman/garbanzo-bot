import type { PlatformMessenger } from '../core/platform-messenger.js';
import { logger } from '../middleware/logger.js';
import { getBridgeMediaMaxBytes } from '../utils/config/bridge.js';
import {
  BRIDGE_MEDIA_MIME_TYPES,
  envelopeSupportsMedia,
  type BridgeEnvelope,
  type BridgeMedia,
} from './envelope.js';

export function envelopeWithoutMedia(envelope: BridgeEnvelope): BridgeEnvelope {
  if (!envelopeSupportsMedia(envelope) || !envelope.media) return envelope;
  const textOnlyEnvelope = { ...envelope };
  delete textOnlyEnvelope.media;
  return textOnlyEnvelope;
}

function isAllowedMediaMimetype(mimetype: string): mimetype is BridgeMedia['mimetype'] {
  return (BRIDGE_MEDIA_MIME_TYPES as readonly string[]).includes(mimetype);
}

export async function sendMediaBestEffort(
  messenger: Pick<PlatformMessenger, 'sendDocument' | 'sendAudio'>,
  envelope: BridgeEnvelope,
): Promise<void> {
  if (!envelopeSupportsMedia(envelope) || !envelope.media) return;

  const { media } = envelope;
  const bytes = Uint8Array.from(Buffer.from(media.data, 'base64'));
  const maxBytes = getBridgeMediaMaxBytes();
  if (bytes.byteLength > maxBytes || !isAllowedMediaMimetype(media.mimetype)) {
    logger.warn(
      {
        routeId: envelope.routeId,
        targetChatId: envelope.targetChatId,
        mimetype: media.mimetype,
        byteLength: bytes.byteLength,
        maxBytes,
      },
      'Bridge: media relay rejected at delivery boundary',
    );
    return;
  }

  try {
    if (media.kind === 'audio') {
      await messenger.sendAudio(envelope.targetChatId, {
        bytes,
        mimetype: media.mimetype,
        ptt: media.ptt,
      });
    } else {
      await messenger.sendDocument(envelope.targetChatId, {
        bytes,
        mimetype: media.mimetype,
        fileName: media.fileName,
      });
    }
  } catch (err) {
    logger.warn(
      { err, routeId: envelope.routeId, targetChatId: envelope.targetChatId, kind: media.kind },
      'Bridge: media relay send failed after text delivery; media skipped',
    );
  }
}
