import { logger } from '../../middleware/logger.js';

/**
 * Slack processor skeleton.
 *
 * This will eventually normalize Slack events into `SlackInbound` and
 * pass them through the core inbound pipeline.
 */
export async function processSlackEvent(_event: unknown): Promise<void> {
  logger.fatal({ platform: 'slack' }, 'Slack processor is not implemented yet');
  throw new Error('Slack processor is not implemented');
}
