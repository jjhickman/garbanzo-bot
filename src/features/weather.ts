import { z } from 'zod';
import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import { bold } from '../utils/formatting.js';

/**
 * Weather feature — Google Weather API integration.
 *
 * Provides current conditions and daily forecast for Boston (default)
 * or any location via Google Geocoding.
 */

const WEATHER_BASE = 'https://weather.googleapis.com/v1';
const GEOCODING_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';
const TIMEOUT_MS = 10_000;

// Boston, MA — default location
const BOSTON = { lat: 42.3601, lng: -71.0589, name: 'Boston' };

// ── Zod schemas (runtime validation for external API responses) ─────

interface Coords { lat: number; lng: number; name: string }

const TemperatureSchema = z.object({ degrees: z.number(), unit: z.string() });
const WeatherConditionSchema = z.object({ description: z.object({ text: z.string() }), type: z.string() });
const WindSchema = z.object({
  direction: z.object({ cardinal: z.string() }),
  speed: z.object({ value: z.number(), unit: z.string() }),
  gust: z.object({ value: z.number(), unit: z.string() }).optional(),
});
const PrecipitationSchema = z.object({ probability: z.object({ percent: z.number(), type: z.string() }) });

const CurrentConditionsSchema = z.object({
  temperature: TemperatureSchema,
  feelsLikeTemperature: TemperatureSchema,
  weatherCondition: WeatherConditionSchema,
  relativeHumidity: z.number(),
  wind: WindSchema,
  precipitation: PrecipitationSchema,
  uvIndex: z.number(),
  isDaytime: z.boolean(),
});
const ForecastDaySchema = z.object({
  displayDate: z.object({ year: z.number(), month: z.number(), day: z.number() }),
  maxTemperature: TemperatureSchema,
  minTemperature: TemperatureSchema,
  daytimeForecast: z.object({ weatherCondition: WeatherConditionSchema, precipitation: PrecipitationSchema }),
});

const ForecastResponseSchema = z.object({ forecastDays: z.array(ForecastDaySchema) });

const GeocodingResponseSchema = z.object({
  status: z.string(),
  results: z.array(z.object({
    formatted_address: z.string(),
    geometry: z.object({ location: z.object({ lat: z.number(), lng: z.number() }) }),
  })),
});

// ── Condition emoji mapping ──────────────────────────────────────────

const CONDITION_EMOJI: Record<string, string> = {
  CLEAR: '☀️',
  MOSTLY_CLEAR: '🌤️',
  PARTLY_CLOUDY: '⛅',
  MOSTLY_CLOUDY: '🌥️',
  CLOUDY: '☁️',
  LIGHT_RAIN: '🌦️',
  RAIN: '🌧️',
  RAIN_SHOWERS: '🌧️',
  SCATTERED_SHOWERS: '🌦️',
  HEAVY_RAIN: '🌧️',
  THUNDERSTORM: '⛈️',
  LIGHT_SNOW: '🌨️',
  SNOW: '❄️',
  SNOW_SHOWERS: '🌨️',
  SCATTERED_SNOW_SHOWERS: '🌨️',
  HEAVY_SNOW: '❄️',
  HAZE: '🌫️',
  FOG: '🌫️',
  WINDY: '💨',
};

function conditionEmoji(type: string): string {
  return CONDITION_EMOJI[type] ?? '🌡️';
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Handle a weather query. Returns a formatted WhatsApp message string.
 */
export async function handleWeather(query: string): Promise<string> {
  if (!config.GOOGLE_API_KEY) {
    return '🫘 Weather is unavailable — no Google API key configured.';
  }

  try {
    const location = await resolveLocation(query);
    const wantsForecast = /\bforecast\b/i.test(query) || /\bweek\b/i.test(query)
      || /\btomorrow\b/i.test(query) || /\bnext\s+\d+\s+days?\b/i.test(query);

    if (wantsForecast) {
      return await getForecast(location);
    }
    return await getCurrentConditions(location);
  } catch (err) {
    logger.error({ err, query }, 'Weather feature error');
    return '🫘 Couldn\'t fetch weather data right now. Try again in a moment.';
  }
}

// ── Location resolution ──────────────────────────────────────────────

/** Extract a location from the query, or default to Boston */
async function resolveLocation(query: string): Promise<Coords> {
  // Check for "weather in <place>" or "weather for <place>" patterns
  const locationMatch = query.match(/(?:weather|forecast|temperature)\s+(?:in|for|at)\s+(.+?)(?:\?|$)/i);

  if (!locationMatch) return BOSTON;

  const place = locationMatch[1].trim();

  // Short-circuit for Boston variants
  if (/^boston/i.test(place)) return BOSTON;

  // Geocode the location
  return await geocode(place);
}

async function geocode(address: string): Promise<Coords> {
  const url = `${GEOCODING_BASE}?address=${encodeURIComponent(address)}&key=${config.GOOGLE_API_KEY}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`Geocoding API error: ${res.status}`);
  }

  const data = GeocodingResponseSchema.parse(await res.json());

  if (data.status !== 'OK' || !data.results.length) {
    logger.warn({ address, status: data.status }, 'Geocoding failed');
    return BOSTON; // Fall back to Boston
  }

  const result = data.results[0];
  return {
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    name: result.formatted_address.split(',')[0], // Just the city name
  };
}

// ── Current conditions ───────────────────────────────────────────────

async function getCurrentConditions(location: Coords): Promise<string> {
  const url = `${WEATHER_BASE}/currentConditions:lookup`
    + `?key=${config.GOOGLE_API_KEY}`
    + `&location.latitude=${location.lat}`
    + `&location.longitude=${location.lng}`
    + `&unitsSystem=IMPERIAL`;

  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Weather API error ${res.status}: ${errText}`);
  }

  const data = CurrentConditionsSchema.parse(await res.json());

  const emoji = conditionEmoji(data.weatherCondition.type);
  const condition = data.weatherCondition.description.text;
  const temp = Math.round(data.temperature.degrees);
  const feelsLike = Math.round(data.feelsLikeTemperature.degrees);
  const humidity = data.relativeHumidity;
  const windSpeed = Math.round(data.wind.speed.value);
  const windDir = formatCardinal(data.wind.direction.cardinal);
  const rainChance = data.precipitation.probability.percent;

  const lines = [
    `${emoji} ${bold(`Weather in ${location.name}`)}`,
    '',
    `${bold(`${temp}°F`)} — ${condition}`,
    `Feels like ${feelsLike}°F`,
    `💧 Humidity: ${humidity}%`,
    `💨 Wind: ${windSpeed} mph ${windDir}`,
  ];

  if (rainChance > 0) {
    lines.push(`🌧️ Rain chance: ${rainChance}%`);
  }

  if (data.uvIndex >= 6) {
    lines.push(`☀️ UV Index: ${data.uvIndex} — wear sunscreen!`);
  }

  return lines.join('\n');
}

// ── Forecast ─────────────────────────────────────────────────────────

async function getForecast(location: Coords): Promise<string> {
  const days = 5;
  const url = `${WEATHER_BASE}/forecast/days:lookup`
    + `?key=${config.GOOGLE_API_KEY}`
    + `&location.latitude=${location.lat}`
    + `&location.longitude=${location.lng}`
    + `&unitsSystem=IMPERIAL`
    + `&days=${days}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Forecast API error ${res.status}: ${errText}`);
  }

  const data = ForecastResponseSchema.parse(await res.json());

  const lines = [`📅 ${bold(`${days}-Day Forecast for ${location.name}`)}`, ''];

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  for (const day of data.forecastDays) {
    const date = new Date(day.displayDate.year, day.displayDate.month - 1, day.displayDate.day);
    const dayName = dayNames[date.getDay()];
    const hi = Math.round(day.maxTemperature.degrees);
    const lo = Math.round(day.minTemperature.degrees);
    const emoji = conditionEmoji(day.daytimeForecast.weatherCondition.type);
    const condition = day.daytimeForecast.weatherCondition.description.text;
    const rain = day.daytimeForecast.precipitation.probability.percent;

    let line = `${emoji} ${bold(dayName)}: ${hi}°/${lo}° — ${condition}`;
    if (rain > 20) {
      line += ` (${rain}% rain)`;
    }
    lines.push(line);
  }

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatCardinal(cardinal: string): string {
  return cardinal
    .replace(/_/g, '')
    .replace(/NORTH/g, 'N')
    .replace(/SOUTH/g, 'S')
    .replace(/EAST/g, 'E')
    .replace(/WEST/g, 'W');
}
