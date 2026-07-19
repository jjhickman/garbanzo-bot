import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';
import type { PlatformMessenger } from '../../core/platform-messenger.js';
import type { PlatformRuntime } from '../types.js';
import { registerChatNameResolver } from '../../core/groups-config.js';

import { createMatrixClient } from './client.js';
import { getMatrixOwnerId, getMatrixRoomName } from './matrix-config.js';
import { resolveOwnerRoomId } from './matrix-owner.js';

export interface MatrixRuntimeDeps {
  createClient?: typeof createMatrixClient;
  getOwnerId?: typeof getMatrixOwnerId;
  resolveOwnerRoomId?: typeof resolveOwnerRoomId;
}

type MatrixClient = ReturnType<typeof createMatrixClient>;

export function createMatrixRuntime(deps: MatrixRuntimeDeps = {}): PlatformRuntime {
  // Digest/recap chat names resolve through core; register this platform's
  // resolver so Matrix rooms don't render as 'Unknown Group'.
  registerChatNameResolver(getMatrixRoomName);
  const runtimeDeps = {
    createClient: deps.createClient ?? createMatrixClient,
    getOwnerId: deps.getOwnerId ?? getMatrixOwnerId,
    resolveOwnerRoomId: deps.resolveOwnerRoomId ?? resolveOwnerRoomId,
  };

  let client: MatrixClient | null = null;
  let currentMessenger: PlatformMessenger | null = null;

  return {
    platform: 'matrix',

    async start(): Promise<void> {
      const homeserverUrl = config.MATRIX_HOMESERVER_URL;
      const accessToken = config.MATRIX_ACCESS_TOKEN;
      const ownerId = runtimeDeps.getOwnerId();

      if (!homeserverUrl || !accessToken || !ownerId) {
        logger.fatal(
          { platform: 'matrix' },
          'Matrix runtime requires MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, and MATRIX_OWNER_ID',
        );
        throw new Error('Matrix runtime requires MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, and MATRIX_OWNER_ID');
      }

      const matrixClient = runtimeDeps.createClient({
        homeserverUrl,
        accessToken,
        ownerId,
        resolveOwnerRoomId: runtimeDeps.resolveOwnerRoomId,
      });
      client = matrixClient;
      await matrixClient.start();

      currentMessenger = matrixClient.getMessenger();
      logger.info({ ownerId }, 'Matrix sync runtime started');
    },

    async stop(): Promise<void> {
      const current = client;
      client = null;
      currentMessenger = null;
      if (current) {
        await current.stop();
      }
    },

    getMessenger(): PlatformMessenger | null {
      return currentMessenger;
    },
  };
}
