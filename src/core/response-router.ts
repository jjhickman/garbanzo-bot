import { logger } from '../middleware/logger.js';
import { getAIResponse } from '../ai/router.js';
import { matchFeature } from '../features/router.js';
import { handleWeather } from '../features/weather.js';
import { handleTransit } from '../features/transit.js';
import { handleNews } from '../features/news.js';
import { getHelpMessage } from '../features/help.js';
import { handleEvent } from '../features/events.js';
import { handleDnd } from '../features/dnd.js';
import { handleBooks } from '../features/books.js';
import { handleVenues } from '../features/venues.js';
import { handlePoll } from '../features/polls.js';
import { handleFun } from '../features/fun.js';
import { handleCharacter } from '../features/character.js';
import { handleProfile } from '../features/profiles.js';
import { handleSummary } from '../features/summary.js';
import { handleRecommendations } from '../features/recommendations.js';
import type { VisionImage } from './vision.js';
import type { MessageContext } from '../ai/persona.js';

/**
 * Try feature-specific handlers first, then fall back to general AI.
 * Features are matched by keyword; if no feature matches, the AI handles it.
 */
export async function getResponse(
  query: string,
  ctx: MessageContext,
  isFeatureEnabled: (chatId: string, feature: string) => boolean,
  visionImages?: VisionImage[],
): Promise<string | null> {
  const feature = matchFeature(query);

  if (feature && isFeatureEnabled(ctx.groupJid, feature.feature)) {
    logger.info({ feature: feature.feature }, 'Routing to feature handler');

    switch (feature.feature) {
      case 'help':
        return getHelpMessage();
      case 'weather':
        return handleWeather(feature.query);
      case 'transit':
        return handleTransit(feature.query);
      case 'news':
        return handleNews(feature.query);
      case 'events':
        return handleEvent(feature.query, ctx.senderJid, ctx.groupJid);
      case 'roll':
      case 'dnd':
        return handleDnd(feature.query);
      case 'books':
        return handleBooks(feature.query);
      case 'venues':
        return handleVenues(feature.query);
      case 'poll': {
        // Polls return string errors only — actual polls handled in group processor
        const result = handlePoll(feature.query);
        return typeof result === 'string' ? result : null;
      }
      case 'fun':
        return handleFun(feature.query);
      case 'character': {
        // In getResponse (DM path), return text summary only — no PDF upload here
        const charResult = await handleCharacter(feature.query);
        return typeof charResult === 'string' ? charResult : charResult.summary;
      }
      case 'profile':
        return await handleProfile(feature.query, ctx.senderJid);
      case 'summary':
        return handleSummary(feature.query, ctx.groupJid, ctx.senderJid);
      case 'recommend':
        return handleRecommendations(feature.query, ctx.senderJid, ctx.groupJid);
    }
  }

  // No feature matched — general AI response (with optional vision)
  return getAIResponse(query, ctx, visionImages);
}
