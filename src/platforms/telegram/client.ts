import { logger } from '../../middleware/logger.js';

import { createTelegramAdapter } from './adapter.js';
import { isTelegramChatEnabled } from './telegram-config.js';
import { processTelegramEvent } from './processor.js';
import { downloadTelegramVoice } from './telegram-voice.js';
import { buildTelegramWelcomeMessage } from './welcome.js';

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
}

function buildSenderName(from: RawTelegramUser | undefined): string | undefined {
  if (!from) return undefined;
  const full = [from.first_name, from.last_name].filter((part) => !!part && part.trim().length > 0).join(' ').trim();
  if (full.length > 0) return full;
  return from.username && from.username.trim().length > 0 ? from.username : undefined;
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
  const mentionsBotByUsername = !!bot.username
    && bot.username.trim().length > 0
    && text.toLowerCase().includes(`@${bot.username.toLowerCase()}`);
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

      let audio: { url: string; contentType: string; buffer?: Buffer } | undefined;
      if (mapped.voice) {
        const buffer = await downloadTelegramVoice(deps.token, mapped.voice.fileId);
        audio = {
          // CREDENTIAL RULE: a safe, non-token-bearing placeholder — never
          // the real Telegram file URL. See telegram-voice.ts.
          url: `telegram-file:${mapped.voice.fileId}`,
          contentType: mapped.voice.mimeType,
          ...(buffer ? { buffer } : {}),
        };
      }

      await processTelegramEvent(adapter, { ...mapped, audio }, {
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
        },
      }).catch((err) => {
        logger.error({ err }, 'Telegram long polling loop exited with an error');
      });
    },

    async stop(): Promise<void> {
      const telegramBot = await getBot();
      await telegramBot.stop();
    },
  };
}
