import { logger } from '../../middleware/logger.js';
import { markConnected, markDisconnected } from '../../middleware/health.js';

import { createMatrixAdapter, type MatrixSendClient } from './adapter.js';
import { downloadMatrixAudio, downloadMatrixMedia } from './matrix-media.js';
import type { MatrixMediaClient } from './matrix-media.js';
import { isMatrixRoomEnabled } from './matrix-config.js';
import { processMatrixEvent } from './processor.js';
import { buildMatrixWelcomeMessage } from './welcome.js';
import { createMatrixStorageProvider, type MatrixStorageProvider } from './sync-storage.js';
import type { MatrixOwnerClient } from './matrix-owner.js';
import { getBridgeMediaMaxBytes, isBridgeMediaEnabled } from '../../utils/config/bridge.js';

export interface RawMatrixMessageContent {
  msgtype?: string;
  body?: string;
  formatted_body?: string;
  format?: string;
  url?: string;
  filename?: string;
  info?: { mimetype?: string; size?: number };
  membership?: string;
  'm.relates_to'?: {
    'm.in_reply_to'?: { event_id?: string };
  };
  'm.mentions'?: {
    user_ids?: string[];
  };
}

export interface RawMatrixEvent {
  event_id?: string;
  room_id?: string;
  type?: string;
  sender?: string;
  state_key?: string;
  origin_server_ts?: number;
  content?: RawMatrixMessageContent;
}

export interface MatrixMappedMessage {
  messageId: string;
  roomId: string;
  isGroupChat: boolean;
  text: string;
  senderId: string;
  senderName?: string;
  timestampMs: number;
  quotedText?: string;
  fromSelf: boolean;
  mentionedIds: string[];
  audio?: { mxcUrl: string; mimeType: string };
  media?: {
    mxcUrl: string;
    mimeType: string;
    fileName: string;
    kind: 'image' | 'video' | 'document';
    size?: number;
  };
}

export interface MatrixClientLike extends MatrixSendClient, MatrixMediaClient {
  on(event: string, handler: (...args: unknown[]) => unknown): unknown;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  getUserId(): Promise<string> | string;
  getUserProfile?(mxid: string): Promise<{ displayname?: string }>;
  joinRoom?(roomId: string): Promise<void>;
}

export interface MatrixSdkFactoryDeps {
  MatrixClient: new (
    homeserverUrl: string,
    accessToken: string,
    storageProvider: MatrixStorageProvider,
  ) => MatrixClientLike;
  SimpleFsStorageProvider?: new (path: string) => MatrixStorageProvider;
}

export interface MatrixClientDeps {
  homeserverUrl: string;
  accessToken: string;
  ownerId: string;
  ownerRoomId?: string;
  resolveOwnerRoomId?: (client: MatrixOwnerClient, ownerId: string) => Promise<string | null>;
  sdkFactory?: () => Promise<MatrixSdkFactoryDeps>;
  client?: MatrixClientLike;
  nodeVersion?: string;
}

const MIN_MATRIX_NODE_MAJOR = 22;

function parseNodeMajor(version: string): number {
  const match = /^v?(\d+)/.exec(version);
  return match ? Number(match[1]) : 0;
}

export function assertMatrixNodeVersion(version: string = process.version): void {
  // matrix-bot-sdk 0.8.0 declares Node >=22. The wider project still
  // supports Node 20, so keep the higher floor localized to Matrix runtime
  // construction instead of raising the whole package engine.
  if (parseNodeMajor(version) < MIN_MATRIX_NODE_MAJOR) {
    throw new Error('Matrix runtime requires Node.js >=22 because matrix-bot-sdk requires Node >=22');
  }
}

async function defaultSdkFactory(): Promise<MatrixSdkFactoryDeps> {
  const importSdk = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<unknown>;
  let sdk: unknown;
  try {
    sdk = await importSdk('matrix-bot-sdk');
  } catch (err) {
    // matrix-bot-sdk is an OPTIONAL dependency (see package.json): a
    // bare-metal npm install on arm64-musl skips it because its native
    // crypto postinstall has no prebuild there. Fail with an actionable
    // message instead of a raw module-not-found.
    throw new Error(
      'Matrix support is not installed. matrix-bot-sdk is an optional dependency that has no '
      + 'arm64-musl build; on that platform run Matrix from the Docker image (which ships a '
      + 'no-native crypto stub), or install Garbanzo on x86-64 or arm64-glibc. '
      + `Underlying import error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const sdkRecord = sdk as unknown as Record<string, unknown>;
  return {
    MatrixClient: sdkRecord.MatrixClient as MatrixSdkFactoryDeps['MatrixClient'],
    SimpleFsStorageProvider: sdkRecord.SimpleFsStorageProvider as MatrixSdkFactoryDeps['SimpleFsStorageProvider'],
  };
}

function senderNameFromMxid(sender: string | undefined): string | undefined {
  if (!sender) return undefined;
  const localpart = /^@([^:]+):/.exec(sender)?.[1];
  return localpart && localpart.length > 0 ? localpart : sender;
}

function stripPlainReplyFallback(body: string): { text: string; quotedText?: string; quotedAuthor?: string } {
  const lines = body.split('\n');
  const quoteLines: string[] = [];
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx];
    if (!line?.startsWith('>')) break;
    quoteLines.push(line.replace(/^> ?/, ''));
    idx += 1;
  }
  if (quoteLines.length === 0) return { text: body };

  // The rich-reply fallback's first quoted line is "<@author:server> text" —
  // the only reply-author signal available without a per-message API call.
  const quotedAuthor = /^<(@[^>]+)>/.exec(quoteLines[0] ?? '')?.[1];

  if (lines[idx] === '') idx += 1;
  return {
    text: lines.slice(idx).join('\n').trimStart(),
    quotedText: quoteLines.join('\n').trim(),
    quotedAuthor,
  };
}

function stripHtmlReplyFallback(formatted: string | undefined): string | undefined {
  if (!formatted) return undefined;
  return formatted.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/i, '').trimStart();
}

function contentText(content: RawMatrixMessageContent): { text: string; quotedText?: string; quotedAuthor?: string } {
  const body = content.body ?? '';
  const plain = stripPlainReplyFallback(body);
  if (plain.quotedText) return plain;

  const strippedHtml = stripHtmlReplyFallback(content.formatted_body);
  if (strippedHtml && strippedHtml !== content.formatted_body) {
    return { text: plain.text };
  }

  return plain;
}

function mentionsBot(text: string, botUserId: string, botDisplayName: string | undefined): boolean {
  if (text.includes(botUserId)) return true;
  if (!botDisplayName) return false;
  const escaped = botDisplayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(?=[:,\\s]|$)`, 'i').test(text);
}

export function mapMatrixMessageToPayload(
  roomId: string,
  event: RawMatrixEvent,
  bot: { userId: string; displayName?: string },
  knownDmRoomId?: string,
): MatrixMappedMessage | null {
  if (event.type !== 'm.room.message') return null;
  const content = event.content;
  if (!content) return null;
  const msgtype = content.msgtype;
  if (!['m.text', 'm.audio', 'm.image', 'm.file', 'm.video'].includes(msgtype ?? '')) return null;

  const textParts = contentText(content);
  // m.audio's body is the FILENAME (or a fallback label like "voice"), not a
  // caption — treating it as text made transcription unreachable, because
  // the processor only transcribes when text is empty. Per MSC2530, body is
  // a real caption only when a separate `filename` field exists and differs
  // from body; everything else clears to empty so the audio path runs.
  const isAudio = msgtype === 'm.audio';
  const isMedia = msgtype === 'm.image' || msgtype === 'm.file' || msgtype === 'm.video';
  const audioCaption = isAudio && content.filename && content.body !== content.filename
    ? textParts.text
    : '';
  const mediaCaption = isMedia && content.filename && content.body !== content.filename
    ? textParts.text
    : '';
  const text = isAudio ? audioCaption : isMedia ? mediaCaption : textParts.text;
  const senderId = event.sender ?? '';
  const mentionedIds = new Set<string>(content['m.mentions']?.user_ids ?? []);
  if (mentionsBot(text, bot.userId, bot.displayName)) {
    mentionedIds.add(bot.userId);
  }
  // A reply only addresses the bot when the replied-to message was the
  // bot's own. Without a per-message API lookup, the reply-fallback quote
  // author is the available signal; modern clients also put the replied-to
  // user in m.mentions (handled above). A reply to anyone else must NOT
  // wake the bot in requireMention rooms.
  if (
    content['m.relates_to']?.['m.in_reply_to']?.event_id
    && textParts.quotedAuthor === bot.userId
  ) {
    mentionedIds.add(bot.userId);
  }

  return {
    messageId: event.event_id ?? '',
    roomId,
    isGroupChat: knownDmRoomId ? roomId !== knownDmRoomId : true,
    text,
    senderId,
    senderName: senderNameFromMxid(senderId),
    timestampMs: event.origin_server_ts ?? Date.now(),
    quotedText: textParts.quotedText,
    fromSelf: senderId === bot.userId,
    mentionedIds: Array.from(mentionedIds),
    audio: msgtype === 'm.audio' && content.url
      ? { mxcUrl: content.url, mimeType: content.info?.mimetype ?? 'audio/ogg' }
      : undefined,
    media: isMedia && content.url
      ? {
        mxcUrl: content.url,
        mimeType: content.info?.mimetype ?? 'application/octet-stream',
        fileName: content.filename ?? content.body ?? 'attachment',
        kind: msgtype === 'm.image' ? 'image' : msgtype === 'm.video' ? 'video' : 'document',
        ...(content.info?.size === undefined ? {} : { size: content.info.size }),
      }
      : undefined,
  };
}

export function createMatrixClient(deps: MatrixClientDeps): {
  start(): Promise<void>;
  stop(): Promise<void>;
  getMessenger(): ReturnType<typeof createMatrixAdapter> | null;
} {
  assertMatrixNodeVersion(deps.nodeVersion);

  let client = deps.client;
  let botIdentity: { userId: string; displayName?: string } | null = null;
  let ownerRoomId = deps.ownerRoomId;
  let messenger: ReturnType<typeof createMatrixAdapter> | null = null;
  let connected = false;
  const adapter = (): ReturnType<typeof createMatrixAdapter> => {
    if (!client) throw new Error('Matrix client has not been initialized');
    return createMatrixAdapter(client);
  };

  async function getClient(): Promise<MatrixClientLike> {
    if (client) return client;
    const sdk = await (deps.sdkFactory ?? defaultSdkFactory)();
    const storage = createMatrixStorageProvider(sdk.SimpleFsStorageProvider);
    client = new sdk.MatrixClient(deps.homeserverUrl, deps.accessToken, storage);
    return client;
  }

  async function resolveBotIdentity(matrixClient: MatrixClientLike): Promise<{ userId: string; displayName?: string }> {
    const userId = await matrixClient.getUserId();
    // Cheap display-name decision: avoid sender profile lookups per message.
    // We fetch the bot's own profile once for mention matching; sender names
    // use the MXID localpart.
    const profile: { displayname?: string } = matrixClient.getUserProfile
      ? await matrixClient.getUserProfile(userId).catch(() => ({}))
      : {};
    return { userId, displayName: profile.displayname ?? senderNameFromMxid(userId) };
  }

  function markFirstSync(): void {
    if (connected) return;
    connected = true;
    markConnected();
  }

  async function handleRoomMessage(roomId: string, event: RawMatrixEvent): Promise<void> {
    try {
      const identity = botIdentity;
      if (!identity) return;
      const mapped = mapMatrixMessageToPayload(roomId, event, identity, ownerRoomId);
      if (!mapped) return;
      if (mapped.fromSelf) return;

      const isDisabledGroupRoom = mapped.isGroupChat && !isMatrixRoomEnabled(mapped.roomId);
      let audio: { url: string; contentType: string; buffer?: Buffer } | undefined;
      if (mapped.audio && !isDisabledGroupRoom) {
        const matrixClient = await getClient();
        const buffer = isBridgeMediaEnabled()
          ? await downloadMatrixAudio(
            matrixClient,
            deps.accessToken,
            mapped.audio.mxcUrl,
            getBridgeMediaMaxBytes(),
          )
          : await downloadMatrixAudio(matrixClient, deps.accessToken, mapped.audio.mxcUrl);
        audio = {
          // Safe mxc URI only; access tokens stay inside the SDK's
          // Authorization headers and are never embedded into URLs.
          url: mapped.audio.mxcUrl,
          contentType: mapped.audio.mimeType,
          ...(buffer ? { buffer } : {}),
        };
      }

      let media: {
        url: string;
        contentType: string;
        fileName: string;
        kind: 'image' | 'video' | 'document';
        buffer?: Buffer;
      } | undefined;
      if (mapped.media) {
        const maxBytes = getBridgeMediaMaxBytes();
        const canDownload = isBridgeMediaEnabled()
          && !isDisabledGroupRoom
          && (mapped.media.size === undefined || mapped.media.size <= maxBytes);
        const buffer = canDownload
          ? await downloadMatrixMedia(await getClient(), deps.accessToken, mapped.media.mxcUrl, maxBytes)
          : null;
        media = {
          url: mapped.media.mxcUrl,
          contentType: mapped.media.mimeType,
          fileName: mapped.media.fileName,
          kind: mapped.media.kind,
          ...(buffer ? { buffer } : {}),
        };
      }

      await processMatrixEvent(adapter(), { ...mapped, audio, media }, {
        ownerId: deps.ownerId,
        ownerRoomId,
        botUserId: identity.userId,
        botDisplayName: identity.displayName,
      });
    } catch (err) {
      logger.error({ err }, 'Matrix message handler failed');
    }
  }

  async function handleRoomEvent(roomId: string, event: RawMatrixEvent): Promise<void> {
    try {
      if (event.type === 'm.room.encryption') {
        logger.warn({ roomId }, 'Matrix encrypted rooms are unsupported; messages in this room are invisible to Garbanzo');
        return;
      }

      if (event.type === 'm.room.member' && event.content?.membership === 'join' && event.state_key) {
        if (!isMatrixRoomEnabled(roomId)) return;
        const identity = botIdentity;
        if (identity && event.state_key === identity.userId) return;
        const welcome = buildMatrixWelcomeMessage({
          roomId,
          memberUserId: event.state_key,
          memberDisplayName: senderNameFromMxid(event.state_key),
        });
        await adapter().sendText(roomId, welcome);
      }
    } catch (err) {
      logger.error({ err }, 'Matrix room event handler failed');
    }
  }

  async function handleInvite(roomId: string): Promise<void> {
    try {
      const matrixClient = await getClient();
      if (!isMatrixRoomEnabled(roomId)) {
        logger.info({ roomId }, 'Matrix invite ignored because room is not configured and enabled');
        return;
      }

      // Invite policy: auto-join only configured+enabled rooms. Matrix bots
      // can be invited by any room, so this mirrors TELEGRAM_CHAT_SCOPE's
      // default-closed posture instead of joining unknown rooms.
      await matrixClient.joinRoom?.(roomId);
      logger.info({ roomId }, 'Matrix invite accepted for configured room');
    } catch (err) {
      logger.error({ err, roomId }, 'Matrix invite handler failed');
    }
  }

  return {
    async start(): Promise<void> {
      const matrixClient = await getClient();
      botIdentity = await resolveBotIdentity(matrixClient);

      matrixClient.on('room.message', (...args: unknown[]) => {
        const [roomId, event] = args as [string, RawMatrixEvent];
        void handleRoomMessage(roomId, event);
      });
      matrixClient.on('room.event', (...args: unknown[]) => {
        const [roomId, event] = args as [string, RawMatrixEvent];
        void handleRoomEvent(roomId, event);
      });
      matrixClient.on('room.invite', (...args: unknown[]) => {
        const [roomId] = args as [string];
        void handleInvite(roomId);
      });
      matrixClient.on('sync', () => {
        markFirstSync();
      });

      ownerRoomId ??= await deps.resolveOwnerRoomId?.(matrixClient, deps.ownerId) ?? undefined;
      if (!ownerRoomId) {
        logger.warn(
          { ownerId: deps.ownerId },
          'Matrix owner DM room could not be resolved; moderation and feedback alerts cannot be delivered until this is fixed',
        );
      }
      messenger = createMatrixAdapter(matrixClient);

      void Promise.resolve(matrixClient.start()).then(() => {
        markFirstSync();
      }).catch((err: unknown) => {
        logger.error({ err }, 'Matrix sync loop exited with an error');
        markDisconnected();
      });
    },

    async stop(): Promise<void> {
      const matrixClient = await getClient();
      await matrixClient.stop();
      connected = false;
      messenger = null;
      markDisconnected();
    },

    getMessenger(): ReturnType<typeof createMatrixAdapter> | null {
      return messenger;
    },
  };
}
