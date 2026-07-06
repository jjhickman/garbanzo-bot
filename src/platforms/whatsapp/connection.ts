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
import { getPersonaName } from '../../ai/persona.js';
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

      // Set the bot's display name so it shows correctly in groups.
      const desiredName = getPersonaName();
      sock.updateProfileName(desiredName).catch((err) => {
        logger.warn({ err, desiredName }, 'Failed to set profile name — may need to set manually in WhatsApp');
      });

      onReady(protectedSock);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const classification = classifyDisconnect(statusCode ?? 0);
      // baileys-antiban's classifyDisconnect mislabels/over-fatals several transient
      // codes (e.g. 428 connectionClosed and 515 restartRequired), which made the bot
      // give up on routine disconnects and tell the operator to re-scan. The
      // credentials are still valid for everything EXCEPT the genuinely terminal
      // reasons below, so reconnect on all others (with bounded backoff).
      const isRestartRequired = statusCode === DisconnectReason.restartRequired;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const TERMINAL_REASONS: Array<number | undefined> = [
        DisconnectReason.loggedOut, // 401 — credentials revoked, must re-link
        DisconnectReason.forbidden, // 403 — account blocked/banned
        DisconnectReason.connectionReplaced, // 440 — another session took over; don't fight it
      ];
      const shouldReconnect = statusCode === undefined || !TERMINAL_REASONS.includes(statusCode);

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
      } else if (isLoggedOut) {
        logger.error('Logged out — runtime paused until WhatsApp is re-linked (delete baileys_auth/ and re-scan QR). Keeping process alive for health monitoring.');
      } else {
        logger.error(
          { statusCode, reason: classification.message },
          'WhatsApp connection ended and will not auto-reconnect (another session took over, or the account is blocked). Credentials are still valid — restart the container once any conflicting session is gone; re-linking is only needed after a real logout.',
        );
      }
    }
  };

  sock.ev.on('connection.update', onConnectionUpdate);

  // CRITICAL: persist auth state on every update
  sock.ev.on('creds.update', saveCreds);

  return protectedSock;
}
