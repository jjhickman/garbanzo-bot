import { logger } from '../../middleware/logger.js';

import type { MatrixSendClient } from './adapter.js';

export interface MatrixOwnerClient extends MatrixSendClient {
  createRoom?(options: Record<string, unknown>): Promise<string | { room_id?: string }>;
  getJoinedRooms?(): Promise<string[]>;
  getRoomMembers?(roomId: string): Promise<string[]>;
}

function getRoomId(result: string | { room_id?: string }): string | null {
  return typeof result === 'string' ? result : result.room_id ?? null;
}

export async function resolveOwnerRoomId(client: MatrixOwnerClient, ownerId: string): Promise<string | null> {
  try {
    if (client.getJoinedRooms && client.getRoomMembers) {
      for (const roomId of await client.getJoinedRooms()) {
        const members = await client.getRoomMembers(roomId);
        if (members.includes(ownerId) && members.length <= 2) {
          return roomId;
        }
      }
    }

    if (!client.createRoom) {
      logger.warn({ ownerId }, 'Matrix owner DM resolution unavailable; createRoom not exposed by client');
      return null;
    }

    const created = await client.createRoom({
      invite: [ownerId],
      is_direct: true,
      preset: 'trusted_private_chat',
    });
    return getRoomId(created);
  } catch (err) {
    logger.warn({ err, ownerId }, 'Matrix owner DM resolution failed');
    return null;
  }
}
