import type { NativeEventPayload } from '../../core/platform-messenger.js';
import { DiscordApiError, discordApiRequest } from './api.js';

/**
 * Discord native events — guild scheduled events over plain REST.
 *
 * Events are created as EXTERNAL (`entity_type: 3`) with GUILD_ONLY privacy
 * (`privacy_level: 2`), because external events need no voice channel. The
 * Discord API requires EXTERNAL events to carry `entity_metadata.location`
 * and `scheduled_end_time`, so both are defaulted when the caller omits
 * them (location `'TBD'`, end = start + 2 hours).
 *
 * The bot needs the **Manage Events** permission in the guild; a 403 is
 * translated into an operator-actionable error message.
 */

const EXTERNAL_ENTITY_TYPE = 3;
const GUILD_ONLY_PRIVACY_LEVEL = 2;
const DEFAULT_EVENT_DURATION_MS = 2 * 60 * 60 * 1000;
const DEFAULT_LOCATION = 'TBD';

export const DISCORD_MANAGE_EVENTS_ERROR =
  'I need the Manage Events permission in this server to manage scheduled events. '
  + 'Ask a server admin to grant it to the bot role.';

interface DiscordChannelResponse {
  id: string;
  guild_id?: string;
}

interface DiscordScheduledEventResponse {
  id: string;
  guild_id: string;
}

interface DiscordEventRef {
  guildId: string;
  eventId: string;
}

export function parseDiscordEventRef(ref: string): DiscordEventRef {
  try {
    const parsed = JSON.parse(ref) as Partial<DiscordEventRef> | null;
    if (parsed && typeof parsed.guildId === 'string' && typeof parsed.eventId === 'string') {
      return { guildId: parsed.guildId, eventId: parsed.eventId };
    }
  } catch {
    // fall through to the shared error below
  }
  throw new Error('Unrecognized Discord event reference');
}

function toScheduledEventBody(event: NativeEventPayload): Record<string, unknown> {
  const endAtMs = event.endAtMs ?? event.startAtMs + DEFAULT_EVENT_DURATION_MS;
  return {
    name: event.name,
    ...(event.description ? { description: event.description } : {}),
    privacy_level: GUILD_ONLY_PRIVACY_LEVEL,
    entity_type: EXTERNAL_ENTITY_TYPE,
    scheduled_start_time: new Date(event.startAtMs).toISOString(),
    scheduled_end_time: new Date(endAtMs).toISOString(),
    entity_metadata: { location: event.location?.trim() || DEFAULT_LOCATION },
  };
}

function translateApiError(err: unknown): never {
  if (err instanceof DiscordApiError && err.status === 403) {
    throw new Error(DISCORD_MANAGE_EVENTS_ERROR);
  }
  throw err;
}

export interface DiscordNativeEventMethods {
  createNativeEvent(chatId: string, event: NativeEventPayload): Promise<string>;
  updateNativeEvent(chatId: string, ref: string, event: NativeEventPayload): Promise<string>;
  cancelNativeEvent(chatId: string, ref: string, event: NativeEventPayload): Promise<void>;
  getNativeEventInterestCount(chatId: string, ref: string): Promise<number | null>;
}

export function createDiscordNativeEventMethods(token: string): DiscordNativeEventMethods {
  const guildIdByChannel = new Map<string, string>();

  async function resolveGuildId(channelId: string): Promise<string> {
    const cached = guildIdByChannel.get(channelId);
    if (cached) return cached;

    const channel = await discordApiRequest<DiscordChannelResponse>(
      token,
      `/channels/${channelId}`,
      { method: 'GET' },
    );
    if (!channel.guild_id) {
      throw new Error('This channel is not in a server, so scheduled events are not available here.');
    }

    guildIdByChannel.set(channelId, channel.guild_id);
    return channel.guild_id;
  }

  return {
    async createNativeEvent(chatId: string, event: NativeEventPayload): Promise<string> {
      const guildId = await resolveGuildId(chatId);
      try {
        const created = await discordApiRequest<DiscordScheduledEventResponse>(
          token,
          `/guilds/${guildId}/scheduled-events`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify(toScheduledEventBody(event)),
          },
        );
        return JSON.stringify({ guildId, eventId: created.id });
      } catch (err) {
        translateApiError(err);
      }
    },

    async updateNativeEvent(_chatId: string, ref: string, event: NativeEventPayload): Promise<string> {
      const { guildId, eventId } = parseDiscordEventRef(ref);
      try {
        await discordApiRequest<DiscordScheduledEventResponse>(
          token,
          `/guilds/${guildId}/scheduled-events/${eventId}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify(toScheduledEventBody(event)),
          },
        );
        return JSON.stringify({ guildId, eventId });
      } catch (err) {
        translateApiError(err);
      }
    },

    async getNativeEventInterestCount(_chatId: string, ref: string): Promise<number | null> {
      const { guildId, eventId } = parseDiscordEventRef(ref);
      // No translateApiError here: the caller degrades to showing the event
      // without counts on ANY failure, so the raw error is fine to throw.
      const event = await discordApiRequest<DiscordScheduledEventResponse & { user_count?: number }>(
        token,
        `/guilds/${guildId}/scheduled-events/${eventId}?with_user_count=true`,
        { method: 'GET' },
      );
      return typeof event.user_count === 'number' ? event.user_count : null;
    },

    async cancelNativeEvent(_chatId: string, ref: string): Promise<void> {
      const { guildId, eventId } = parseDiscordEventRef(ref);
      try {
        await discordApiRequest<Record<string, never>>(
          token,
          `/guilds/${guildId}/scheduled-events/${eventId}`,
          { method: 'DELETE' },
        );
      } catch (err) {
        translateApiError(err);
      }
    },
  };
}
