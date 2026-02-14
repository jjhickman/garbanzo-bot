import { logger } from '../middleware/logger.js';
import { isFeatureEnabled } from './groups.js';
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
import type { VisionImage } from '../features/media.js';

/**
 * Try feature-specific handlers first, then fall back to general AI.
 * Features are matched by keyword; if no feature matches, Claude handles it.
 */
export async function getResponse(
  query: string,
  ctx: import('../ai/persona.js').MessageContext,
  visionImages?: VisionImage[],
): Promise<string | null> {
  const feature = matchFeature(query);

  if (feature && isFeatureEnabled(ctx.groupJid, feature.feature)) {
    logger.info({ feature: feature.feature }, 'Routing to feature handler');

    switch (feature.feature) {
      case 'help':
        return getHelpMessage();
      case 'weather':
        return await handleWeather(feature.query);
      case 'transit':
        return await handleTransit(feature.query);
      case 'news':
        return await handleNews(feature.query);
      case 'events':
        return await handleEvent(feature.query, ctx.senderJid, ctx.groupJid);
      case 'roll':
      case 'dnd':
        return await handleDnd(feature.query);
      case 'books':
        return await handleBooks(feature.query);
      case 'venues':
        return await handleVenues(feature.query);
      case 'poll':
        // Polls return string errors only — actual polls handled above
        return typeof handlePoll(feature.query) === 'string' ? handlePoll(feature.query) as string : null;
      case 'fun':
        return await handleFun(feature.query);
      case 'character': {
        // In getResponse (DM path), return text summary only — no PDF upload here
        const charResult = await handleCharacter(feature.query);
        return typeof charResult === 'string' ? charResult : charResult.summary;
      }
      case 'profile':
        return handleProfile(feature.query, ctx.senderJid);
      case 'summary':
        return await handleSummary(feature.query, ctx.groupJid, ctx.senderJid);
      case 'recommend':
        return await handleRecommendations(feature.query, ctx.senderJid, ctx.groupJid);
    }
  }

  // No feature matched — general AI response (with optional vision)
  return await getAIResponse(query, ctx, visionImages);
}
