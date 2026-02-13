import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type ConnectionState,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { resolve } from 'path';
import { logger } from '../middleware/logger.js';
import { PROJECT_ROOT } from '../utils/config.js';

const AUTH_DIR = resolve(PROJECT_ROOT, 'baileys_auth');
const baileysLogger = logger.child({ module: 'baileys' });

// Suppress Baileys internal noise
baileysLogger.level = 'warn';

export type MessageHandler = (sock: WASocket) => void;

/**
 * Create and manage the Baileys WhatsApp connection.
 * Handles auth persistence, reconnection, and lifecycle.
 */
export async function startConnection(
  onReady: MessageHandler,
): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  logger.info({ version }, 'Starting Baileys connection');

  const sock = makeWASocket({
    version,
    logger: baileysLogger as any,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger as any),
    },
    printQRInTerminal: true,
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
  });

  // Connection lifecycle
  sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('QR code generated — scan with WhatsApp to connect');
    }

    if (connection === 'open') {
      logger.info('✅ Connected to WhatsApp');
      onReady(sock);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn(
        { statusCode, shouldReconnect },
        'Connection closed',
      );

      if (shouldReconnect) {
        logger.info('Reconnecting in 3 seconds...');
        setTimeout(() => startConnection(onReady), 3000);
      } else {
        logger.error('Logged out — delete baileys_auth/ and re-scan QR code');
        process.exit(1);
      }
    }
  });

  // CRITICAL: persist auth state on every update
  sock.ev.on('creds.update', saveCreds);

  return sock;
}
