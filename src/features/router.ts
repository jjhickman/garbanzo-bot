import { logger } from '../middleware/logger.js';

/**
 * Feature routing — detect which feature (if any) should handle a query
 * before falling through to the general AI response.
 *
 * Returns a FeatureMatch if a keyword pattern matches, or null to fall
 * through to Claude.
 */

export interface FeatureMatch {
  feature: 'weather' | 'transit' | 'news' | 'help';
  /** The original query with feature keywords left intact (features parse their own args) */
  query: string;
}

interface FeaturePattern {
  feature: FeatureMatch['feature'];
  patterns: RegExp[];
}

const FEATURE_PATTERNS: FeaturePattern[] = [
  {
    feature: 'help',
    patterns: [
      /^\s*help\s*$/i,
      /\bwhat can you do\b/i,
      /\bwhat do you do\b/i,
      /\bcommands?\b/i,
      /\bfeatures?\b/i,
      /\bhow do I use\b/i,
      /\bwhat are you\b/i,
    ],
  },
  {
    feature: 'weather',
    patterns: [
      /\bweather\b/i,
      /\bforecast\b/i,
      /\btemperature\b/i,
      /\bhow hot\b/i,
      /\bhow cold\b/i,
      /\bis it raining\b/i,
      /\bwill it rain\b/i,
      /\bwill it snow\b/i,
      /\bis it snowing\b/i,
    ],
  },
  {
    feature: 'transit',
    patterns: [
      /\bmbta\b/i,
      /\bthe t\b/i,
      /\btrain\b/i,
      /\bsubway\b/i,
      /\bbus\b/i,
      /\bred line\b/i,
      /\borange line\b/i,
      /\bblue line\b/i,
      /\bgreen line\b/i,
      /\bcommuter rail\b/i,
      /\bnext (train|bus|arrival)\b/i,
      /\btransit\b/i,
      /\bservice alert/i,
      /\bdelays?\b/i,
      /\bshuttle\b/i,
    ],
  },
  {
    feature: 'news',
    patterns: [
      /\bnews\b/i,
      /\bheadlines?\b/i,
      /\bwhat('s| is) happening\b/i,
      /\bcurrent events\b/i,
    ],
  },
];

/**
 * Match a query against feature keyword patterns.
 * Returns the first matching feature, or null for general AI handling.
 */
export function matchFeature(query: string): FeatureMatch | null {
  for (const { feature, patterns } of FEATURE_PATTERNS) {
    if (patterns.some((p) => p.test(query))) {
      logger.debug({ feature, query }, 'Feature matched');
      return { feature, query };
    }
  }
  return null;
}
