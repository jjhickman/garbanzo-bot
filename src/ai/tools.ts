import { config } from '../utils/config.js';
import { recordToolCall } from '../middleware/stats.js';

const TOOL_RESULT_MAX_CHARS = 1500;

export interface AiToolParameter {
  type: 'string';
  description: string;
}

export interface AiTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, AiToolParameter>;
    required: string[];
  };
  execute(input: Record<string, unknown>): Promise<string>;
}

function stringInput(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateToolResult(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS - 3)}...`;
}

function errorMessage(name: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Tool ${name} failed: ${message}`;
}

function queryTool(
  name: string,
  description: string,
  parameterName: 'query' | 'keyword',
  parameterDescription: string,
  run: (value: string) => Promise<string>,
): AiTool {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        [parameterName]: { type: 'string', description: parameterDescription },
      },
      required: [parameterName],
    },
    execute: async (input) => {
      const value = stringInput(input, parameterName);
      if (!value) {
        recordToolCall(name, 'error');
        return `Tool ${name} needs a non-empty ${parameterName}.`;
      }

      try {
        const result = truncateToolResult(await run(value));
        recordToolCall(name, 'ok');
        return result;
      } catch (err) {
        recordToolCall(name, 'error');
        return truncateToolResult(errorMessage(name, err));
      }
    },
  };
}

const tools: AiTool[] = [
  queryTool(
    'get_weather',
    'Get current weather or forecast for Boston-area locations and other free-text places.',
    'query',
    'Free-text weather request, for example "forecast tomorrow somerville".',
    async (query) => {
      const { handleWeather } = await import('../features/weather.js');
      return handleWeather(query);
    },
  ),
  queryTool(
    'get_transit_status',
    'Get MBTA status, alerts, schedules, or next arrivals from a natural-language transit request.',
    'query',
    'Free-text transit request, for example "red line status" or "next train at Park Street".',
    async (query) => {
      const { handleTransit } = await import('../features/transit.js');
      return handleTransit(query);
    },
  ),
  queryTool(
    'find_venues',
    'Find Boston-area venues or details for outings, food, activities, and meeting places.',
    'query',
    'Free-text venue request, for example "quiet bars in Somerville".',
    async (query) => {
      const { handleVenues } = await import('../features/venues.js');
      return handleVenues(query);
    },
  ),
  queryTool(
    'get_news',
    'Search current news or top headlines for a topic.',
    'query',
    'Free-text news request, for example "latest news about MBTA funding".',
    async (query) => {
      const { handleNews } = await import('../features/news.js');
      return handleNews(query);
    },
  ),
  queryTool(
    'lookup_book',
    'Look up books by title, author, or ISBN using Open Library.',
    'query',
    'Free-text book request, for example "author Octavia Butler" or "isbn 9780143111580".',
    async (query) => {
      const { handleBooks } = await import('../features/books.js');
      return handleBooks(query);
    },
  ),
  queryTool(
    'search_community_memory',
    'Search saved community memory facts that Garbanzo has been asked to remember.',
    'keyword',
    'Keyword or phrase to search in community memory.',
    async (keyword) => {
      const { searchMemory } = await import('../utils/db.js');
      const results = await searchMemory(keyword, 5);
      if (results.length === 0) return `No community memory found for "${keyword}".`;
      return results
        .map((memory) => `- ${memory.fact} (${memory.category})`)
        .join('\n');
    },
  ),
];

export function getEnabledTools(): AiTool[] {
  if (!config.AI_TOOL_CALLING) return [];

  return tools.filter((tool) => {
    if (tool.name === 'get_weather') return !!config.GOOGLE_API_KEY;
    if (tool.name === 'find_venues') return !!config.GOOGLE_API_KEY;
    if (tool.name === 'get_transit_status') return !!config.MBTA_API_KEY;
    if (tool.name === 'get_news') return !!config.NEWSAPI_KEY;
    return true;
  });
}
