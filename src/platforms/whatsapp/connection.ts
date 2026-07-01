import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type ConnectionState,
} from '@whiskeysockets/baileys';
import type { ILogger } from '@whiskeysockets/baileys/lib/Utils/logger.js';
import { Boom } from '@hapi/boom';
import { classifyDisconnect } from 'baileys-antiban';
import { resolve } from 'path';

import { logger } from '../../middleware/logger.js';
import { config, PROJECT_ROOT } from '../../utils/config.js';
import { markConnected, markDisconnected } from '../../middleware/health.js';
import { createProtectedWhatsAppSocket, getWhatsAppOutboundSafety } from './outbound-safety.js';
import { markLinked, markUnlinked, routeLoginQr, setActiveSocket } from './login-store.js';

const AUTH_DIR = resolve(PROJECT_ROOT, 'baileys_auth');
const baileysLogger = logger.child({ module: 'baileys' });

// Suppress Baileys internal noise
baileysLogger.level = 'warn';

type MessageHandler = (sock: WASocket) => void;

/**
 * Create and manage the Baileys WhatsApp connection.
 * Handles auth persistence, reconnection, and lifecycle.
 */
export async function startConnection(
  onReady: MessageHandler,
  onClosed?: () => void,
  onSocketCreated?: (sock: WASocket) => void,
): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  logger.info({ version }, 'Starting Baileys connection');

  const sock = makeWASocket({
    version,
    logger: baileysLogger as ILogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger as ILogger),
    },
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
  });
  const protectedSock = createProtectedWhatsAppSocket(sock);
  onSocketCreated?.(protectedSock);
  setActiveSocket(protectedSock);
  const safety = getWhatsAppOutboundSafety(protectedSock);

  // Connection lifecycle
  const onConnectionUpdate = (update: Partial<ConnectionState>): void => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('QR code generated — scan with WhatsApp to connect');
      routeLoginQr(qr, config.WHATSAPP_LOGIN_MODE);
    }

    if (connection === 'open') {
      logger.info({ botJid: sock.user?.id }, '✅ Connected to WhatsApp');
      markConnected();
      markLinked();
      safety?.onConnected();

      // Set the bot's display name so it shows as "Garbanzo Bean" in groups
      sock.updateProfileName('Garbanzo Bean').catch((err) => {
        logger.warn({ err, desiredName: 'Garbanzo Bean' }, 'Failed to set profile name — may need to set manually in WhatsApp');
      });

      onReady(protectedSock);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const classification = classifyDisconnect(statusCode ?? 0);
      // 515 (restartRequired) is the normal signal WhatsApp sends immediately after
      // a successful QR scan / pairing: the credentials are valid and the client MUST
      // reconnect to finish linking. baileys-antiban misclassifies it as fatal, so
      // override — otherwise the very first link never completes.
      const isRestartRequired = statusCode === DisconnectReason.restartRequired;
      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut &&
        (isRestartRequired || classification.shouldReconnect);

      markDisconnected();
      markUnlinked();
      safety?.onDisconnected(statusCode ?? 0);
      safety?.destroy();
      try { onClosed?.(); } catch (err) { logger.warn({ err }, 'WhatsApp close disposer failed'); }

      // Enforce the single-socket invariant: fully retire this socket before any reconnect.
      try { sock.ev.off('connection.update', onConnectionUpdate); } catch { /* best effort */ }
      try { sock.end(undefined); } catch (err) { logger.warn({ err }, 'Socket end during retirement failed'); }

      logger.warn(
        { statusCode, shouldReconnect, disconnectCategory: classification.category, message: classification.message },
        'Connection closed',
      );

      if (shouldReconnect) {
        // restartRequired should reconnect promptly to complete linking.
        const backoffMs = isRestartRequired ? 1000 : (classification.backoffMs ?? 3000);
        logger.info({ backoffMs }, 'Scheduling WhatsApp reconnect');
        setTimeout(() => startConnection(onReady, onClosed, onSocketCreated), backoffMs);
      } else {
        logger.error('Logged out — runtime paused until WhatsApp is re-linked (delete baileys_auth/ and re-scan QR). Keeping process alive for health monitoring.');
      }
    }
  };

  sock.ev.on('connection.update', onConnectionUpdate);

  // CRITICAL: persist auth state on every update
  sock.ev.on('creds.update', saveCreds);

  return protectedSock;
}
