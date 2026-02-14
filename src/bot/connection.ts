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
// @ts-expect-error — qrcode-terminal has no type declarations
import qrcode from 'qrcode-terminal';
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
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
  });

  // Connection lifecycle
  sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('QR code generated — scan with WhatsApp to connect');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info({ botJid: sock.user?.id }, '✅ Connected to WhatsApp');

      // Set the bot's display name so it shows as "Garbanzo Bean" in groups
      sock.updateProfileName('Garbanzo Bean').catch((err) => {
        logger.warn({ err }, 'Failed to set profile name — may need to set manually in WhatsApp');
      });

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
