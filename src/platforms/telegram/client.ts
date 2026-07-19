import { logger } from '../../middleware/logger.js';
import { markConnected, markDisconnected } from '../../middleware/health.js';

import { createTelegramAdapter } from './adapter.js';
import { isTelegramChatEnabled } from './telegram-config.js';
import { processTelegramEvent } from './processor.js';
import { downloadTelegramVoice } from './telegram-voice.js';
import { getBridgeMediaMaxBytes, isBridgeMediaEnabled } from '../../utils/config/bridge.js';
import { buildTelegramWelcomeMessage } from './welcome.js';
import {
  mapTelegramMedia,
  prepareTelegramMedia,
  type RawTelegramDocument,
  type RawTelegramPhoto,
  type TelegramMappedMedia,
} from './telegram-media.js';

// ── Minimal raw Telegram Bot API shapes ────────────────────────────────
// Deliberately hand-rolled (not imported from grammY's type tree) so the
// mapping function stays pure and trivially testable with plain JSON
// fixtures — mirrors Discord's DiscordMessagePayload approach.

export interface RawTelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface RawTelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
}

export interface RawTelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface RawTelegramMessage {
  message_id: number;
  date: number;
  chat: RawTelegramChat;
  from?: RawTelegramUser;
  text?: string;
  caption?: string;
  reply_to_message?: RawTelegramMessage;
  voice?: RawTelegramVoice;
  photo?: RawTelegramPhoto[];
  document?: RawTelegramDocument;
  new_chat_members?: RawTelegramUser[];
}

export interface TelegramContextLike {
  update: { message?: RawTelegramMessage };
  me?: { id: number; username?: string };
}

export interface TelegramBotIdentity {
  id?: number;
  username?: string;
}

export interface TelegramMappedMessage {
  messageId: string;
  chatId: string;
  isGroupChat: boolean;
  text: string;
  senderId: string;
  senderName?: string;
  timestampMs: number;
  quotedText?: string;
  fromSelf: boolean;
  mentionedIds: string[];
  voice?: { fileId: string; mimeType: string };
  media?: TelegramMappedMedia;
}

function buildSenderName(from: RawTelegramUser | undefined): string | undefined {
  if (!from) return undefined;
  const full = [from.first_name, from.last_name].filter((part) => !!part && part.trim().length > 0).join(' ').trim();
  if (full.length > 0) return full;
  return from.username && from.username.trim().length > 0 ? from.username : undefined;
}

/**
 * True when `text` contains an `@username` mention of the bot as a whole
 * token — F8 (T2 review): a plain case-insensitive `.includes()` false-
 * positives on substrings, e.g. bot username `mybot` matching inside
 * `@mybotmail.com`. The mention must be followed by a non-word character
 * (anything other than `[A-Za-z0-9_]`) or the end of the string.
 */
function hasBotUsernameMention(text: string, username: string | undefined): boolean {
  if (!username || username.trim().length === 0) return false;
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@${escaped}(?![A-Za-z0-9_])`, 'i').test(text);
}

/**
 * Pure mapping from a raw Telegram message to a normalized payload —
 * mirrors Discord gateway-client.ts's mapMessageToPayload. Resolves the
 * "was the bot addressed" signal (a reply to one of the bot's own messages,
 * or an @username mention in the text) into `mentionedIds`, the same shape
 * Discord's mentionedIds carries, so processor.ts reuses the exact same
 * mention-gating idiom.
 */
export function mapTelegramMessageToPayload(
  message: RawTelegramMessage,
  bot: TelegramBotIdentity,
): TelegramMappedMessage {
  const chat = message.chat;
  const from = message.from;
  const text = message.text ?? message.caption ?? '';
  const replyToMessage = message.reply_to_message;
  const quotedText = replyToMessage?.text ?? replyToMessage?.caption;
  const isReplyToBot = bot.id !== undefined && replyToMessage?.from?.id === bot.id;
  const mentionsBotByUsername = hasBotUsernameMention(text, bot.username);
  const mentionedIds = (isReplyToBot || mentionsBotByUsername) && bot.id !== undefined
    ? [String(bot.id)]
    : [];
  const fromSelf = bot.id !== undefined && from?.id === bot.id;

  return {
    messageId: String(message.message_id),
    chatId: String(chat.id),
    isGroupChat: chat.type === 'group' || chat.type === 'supergroup',
    text,
    senderId: from ? String(from.id) : '',
    senderName: buildSenderName(from),
    timestampMs: message.date * 1000,
    quotedText,
    fromSelf,
    mentionedIds,
    voice: message.voice
      ? { fileId: message.voice.file_id, mimeType: message.voice.mime_type ?? 'audio/ogg' }
      : undefined,
    media: mapTelegramMedia(message),
  };
}

export interface TelegramBotLike {
  on(event: string, handler: (ctx: TelegramContextLike) => unknown | Promise<unknown>): unknown;
  catch(handler: (err: unknown) => unknown): void;
  init(): Promise<void>;
  start(options?: { onStart?: (info: { id: number; username?: string }) => void }): Promise<void>;
  stop(): Promise<void>;
  readonly botInfo?: { id: number; username?: string };
}

export interface TelegramClientDeps {
  token: string;
  ownerId: string;
  ownerUserId?: string;
  botFactory?: () => TelegramBotLike;
}

async function defaultBotFactory(token: string): Promise<TelegramBotLike> {
  const { Bot } = await import('grammy');
  return new Bot(token) as unknown as TelegramBotLike;
}

export function createTelegramClient(deps: TelegramClientDeps): {
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  const adapter = createTelegramAdapter(deps.token);
  let bot = deps.botFactory?.();
  let botIdentity: TelegramBotIdentity = {};

  async function getBot(): Promise<TelegramBotLike> {
    bot ??= await defaultBotFactory(deps.token);
    return bot;
  }

  async function handleNewChatMembers(message: RawTelegramMessage): Promise<void> {
    try {
      const chatId = String(message.chat.id);
      if (!isTelegramChatEnabled(chatId)) return;

      for (const member of message.new_chat_members ?? []) {
        // The bot itself joining a chat is not a member to welcome.
        if (botIdentity.id !== undefined && member.id === botIdentity.id) continue;

        const welcome = buildTelegramWelcomeMessage({
          chatId,
          memberUserId: String(member.id),
          memberDisplayName: buildSenderName(member),
        });
        await adapter.sendText(chatId, welcome);
      }
    } catch (err) {
      logger.error({ err }, 'Telegram new chat member handler failed');
    }
  }

  async function handleMessage(ctx: TelegramContextLike): Promise<void> {
    try {
      const message = ctx.update?.message;
      if (!message) return;

      if (Array.isArray(message.new_chat_members) && message.new_chat_members.length > 0) {
        await handleNewChatMembers(message);
        return;
      }

      const mapped = mapTelegramMessageToPayload(message, botIdentity);
      // Loop prevention: never dispatch the bot's own messages.
      if (mapped.fromSelf) return;

      // F7 (T2 review): gate on the cheap chatId/isGroupChat fields BEFORE
      // any network call. Telegram's getFile is a real fetch anyone can
      // trigger by adding this bot to a group, so a disabled/unconfigured
      // group chat must never cause a voice download. DMs are never gated
      // here — isTelegramChatEnabled only tracks configured GROUP chats.
      const isDisabledGroupChat = mapped.isGroupChat && !isTelegramChatEnabled(mapped.chatId);

      let audio: { url: string; contentType: string; buffer?: Buffer; ptt?: boolean } | undefined;
      if (mapped.voice && !isDisabledGroupChat) {
        const buffer = isBridgeMediaEnabled()
          ? await downloadTelegramVoice(deps.token, mapped.voice.fileId, { maxBytes: getBridgeMediaMaxBytes() })
          : await downloadTelegramVoice(deps.token, mapped.voice.fileId);
        audio = {
          // CREDENTIAL RULE: a safe, non-token-bearing placeholder — never
          // the real Telegram file URL. See telegram-voice.ts.
          url: `telegram-file:${mapped.voice.fileId}`,
          contentType: mapped.voice.mimeType,
          ptt: true,
          ...(buffer ? { buffer } : {}),
        };
      }

      const media = mapped.media
        ? await prepareTelegramMedia(deps.token, mapped.media, !isDisabledGroupChat)
        : undefined;

      await processTelegramEvent(adapter, { ...mapped, audio, media }, {
        ownerId: deps.ownerId,
        ownerUserId: deps.ownerUserId,
        botUserId: botIdentity.id !== undefined ? String(botIdentity.id) : undefined,
        botUsername: botIdentity.username,
      });
    } catch (err) {
      logger.error({ err }, 'Telegram message handler failed');
    }
  }

  return {
    async start(): Promise<void> {
      const telegramBot = await getBot();
      telegramBot.on('message', handleMessage);
      telegramBot.catch((err) => {
        logger.error({ err }, 'Telegram bot middleware error');
      });

      // grammY's init() performs the getMe() handshake and surfaces auth
      // failures (bad token) synchronously here, and populates botInfo —
      // read it immediately so identity is available before the first
      // update can possibly arrive (no race on onStart's async timing).
      // start() then only needs to enter the long-polling loop, which
      // grammY retries internally on transient network errors using its
      // built-in backoff — we do not reimplement reconnect/backoff, just
      // log if the loop itself exits with an error. We deliberately do not
      // await start() — per grammY's docs, it resolves only once stopped.
      await telegramBot.init();
      if (telegramBot.botInfo) {
        botIdentity = { id: telegramBot.botInfo.id, username: telegramBot.botInfo.username };
      }

      void telegramBot.start({
        onStart: (info) => {
          botIdentity = { id: info.id, username: info.username };
          logger.info({ botId: info.id, botUsername: info.username }, 'Telegram long polling started');
          // F4 (T2 review): Telegram DELIBERATELY reports into the shared
          // health module here — unlike Discord's runtime, which stays
          // silent by design (see runtime.ts for that separate decision).
          // Without this, /health/ready was permanently 503 for Telegram
          // even while long-polling was healthy.
          markConnected();
        },
      }).catch((err) => {
        // grammY rethrows terminal auth/session errors (401 unauthorized,
        // 409 conflict — another poller already running) instead of
        // retrying internally; that must surface as both a loud log AND a
        // health-visible disconnect, not just a swallowed background
        // rejection nobody sees while /health stays green.
        logger.error({ err }, 'Telegram long polling loop exited with an error');
        markDisconnected();
      });
    },

    async stop(): Promise<void> {
      const telegramBot = await getBot();
      await telegramBot.stop();
      markDisconnected();
    },
  };
}
