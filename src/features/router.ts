import { logger } from '../middleware/logger.js';

/**
 * Feature routing — detect which feature (if any) should handle a query
 * before falling through to the general AI response.
 *
 * Supports two styles:
 * 1. Bang commands: "!weather Boston", "!transit red line", "!news tech"
 * 2. Natural language: "what's the weather?", "red line status", etc.
 *
 * Bang commands are checked first (faster, unambiguous).
 * Returns a FeatureMatch if matched, or null to fall through to Claude.
 */

export interface FeatureMatch {
  feature: 'weather' | 'transit' | 'news' | 'help' | 'events' | 'dnd' | 'roll' | 'books' | 'venues' | 'poll' | 'fun' | 'character';
  /** The query with command prefix stripped (for bang commands) or original text (natural language) */
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
  {
    feature: 'venues',
    patterns: [
      /\bfind\s+(a\s+)?(bar|restaurant|venue|place|spot|bowling|escape\s+room|karaoke|park|cafe|coffee|gym)\b/i,
      /\b(bars?|restaurants?|venues?|places?)\s+(in|near|around)\b/i,
    ],
  },
  {
    feature: 'books',
    patterns: [
      /\bbook\s+(club|rec|recommend)/i,
      /\bwhat.+read(ing)?\b/i,
      /\breading\s+list\b/i,
      /\bbook\s+by\b/i,
    ],
  },
  {
    feature: 'roll',
    patterns: [
      // Dice notation: "roll 2d6", "roll me a d20", "2d6+3"
      /\broll\s+\d*d\d/i,
      /\broll\s+(me\s+)?a?\s*d\d/i,
      /^\d*d\d+([+-]\d+)?$/i,
    ],
  },
  {
    feature: 'dnd',
    patterns: [
      /\bspell\s+\w/i,
      /\bmonster\s+\w/i,
      /\bstat\s*block\b/i,
      /\blookup\s+(spell|monster|class|item)\b/i,
    ],
  },
  {
    feature: 'character',
    patterns: [
      // Explicit: "create a character", "make a char", "build a character sheet"
      /\b(create|generate|make|build)\s+(me\s+)?(a\s+)?(character|char)\b/i,
      /\bcharacter\s+(sheet|create|gen|build|random)\b/i,
      /\bnew\s+character\b/i,
      // Creation verb + race/class name (no "character" keyword needed):
      // "make me an elf wizard", "create a dwarf fighter", "roll up a half-orc barbarian"
      /\b(create|generate|make|build|roll)\s+(me\s+)?(up\s+)?(an?\s+)?(dragonborn|dwarf|dwarven|elf|elven|gnome|half[- ]?elf|half[- ]?orc|halfling|human|tiefling|barbarian|bard|cleric|druid|fighter|monk|paladin|ranger|rogue|sorcerer|warlock|wizard)\b/i,
      // "I want to play a [race/class]", "I want to be a [race/class]", "I wanna be a wizard"
      /\bwant\s+to\s+(play|be)\s+(an?\s+)?(dragonborn|dwarf|dwarven|elf|elven|gnome|half[- ]?elf|half[- ]?orc|halfling|human|tiefling|barbarian|bard|cleric|druid|fighter|monk|paladin|ranger|rogue|sorcerer|warlock|wizard)\b/i,
      /\bwanna\s+(play|be)\s+(an?\s+)?(dragonborn|dwarf|dwarven|elf|elven|gnome|half[- ]?elf|half[- ]?orc|halfling|human|tiefling|barbarian|bard|cleric|druid|fighter|monk|paladin|ranger|rogue|sorcerer|warlock|wizard)\b/i,
    ],
  },
  {
    feature: 'events',
    patterns: [
      // "plan a/an X", "plan dinner", "plan a hike"
      /\bplan\s+(?:a\s+)?(?:trivia|karaoke|dinner|brunch|lunch|drinks|happy\s+hour|hike|game\s+night|movie|concert|bar\s+crawl|bowling|escape\s+room|event|meetup|outing|gathering)\b/i,
      // "event this/next/on"
      /\bevent\s+(?:this|next|on|tomorrow|tonight)\b/i,
      // "let's do X" — only when @mentioned
      /\blet'?s\s+(?:do|have|plan|go\s+to)\s+.+(?:tonight|tomorrow|this|next|friday|saturday|sunday|monday|tuesday|wednesday|thursday)/i,
      // "anyone down for X"
      /\banyone\s+(?:down|interested|want|wanna)\s+(?:for|to)\b/i,
    ],
  },
];

// ── Bang command mapping ────────────────────────────────────────────

const BANG_COMMANDS: Record<string, FeatureMatch['feature']> = {
  '!help': 'help',
  '!weather': 'weather',
  '!forecast': 'weather',
  '!transit': 'transit',
  '!mbta': 'transit',
  '!train': 'transit',
  '!bus': 'transit',
  '!news': 'news',
  '!events': 'events',
  '!plan': 'events',
  '!roll': 'roll',
  '!dice': 'roll',
  '!dnd': 'dnd',
  '!spell': 'dnd',
  '!monster': 'dnd',
  '!book': 'books',
  '!books': 'books',
  '!read': 'books',
  '!venue': 'venues',
  '!venues': 'venues',
  '!find': 'venues',
  '!place': 'venues',
  '!poll': 'poll',
  '!vote': 'poll',
  '!character': 'character',
  '!char': 'character',
  '!charsheet': 'character',
  '!trivia': 'fun',
  '!fact': 'fun',
  '!today': 'fun',
  '!icebreaker': 'fun',
  '!ice': 'fun',
  '!fun': 'fun',
};

/**
 * Match a query against bang commands first, then natural language patterns.
 * Returns the first matching feature, or null for general AI handling.
 */
export function matchFeature(query: string): FeatureMatch | null {
  const trimmed = query.trim();

  // Bang command — fast exact prefix match
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  const bangFeature = BANG_COMMANDS[firstWord];
  if (bangFeature) {
    const rest = trimmed.slice(firstWord.length).trim();
    // For fun commands, preserve the subcommand (e.g. !trivia science → "trivia science")
    const bangWord = firstWord.slice(1); // strip "!"
    const FUN_SUBCOMMANDS = ['trivia', 'fact', 'today', 'icebreaker', 'ice', 'fun'];
    const args = bangFeature === 'fun' && FUN_SUBCOMMANDS.includes(bangWord)
      ? `${bangWord}${rest ? ' ' + rest : ''}`
      : rest || trimmed;
    logger.debug({ feature: bangFeature, query: args, style: 'bang' }, 'Feature matched');
    return { feature: bangFeature, query: args };
  }

  // Natural language patterns
  for (const { feature, patterns } of FEATURE_PATTERNS) {
    if (patterns.some((p) => p.test(query))) {
      logger.debug({ feature, query, style: 'natural' }, 'Feature matched');
      return { feature, query };
    }
  }
  return null;
}
