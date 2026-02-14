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

// Boston, MA — default location
const BOSTON = { lat: 42.3601, lng: -71.0589, name: 'Boston' };

// ── Types ────────────────────────────────────────────────────────────

interface Coords {
  lat: number;
  lng: number;
  name: string;
}

interface Temperature {
  degrees: number;
  unit: string;
}

interface WeatherCondition {
  description: { text: string };
  type: string;
}

interface Wind {
  direction: { cardinal: string };
  speed: { value: number; unit: string };
  gust?: { value: number; unit: string };
}

interface Precipitation {
  probability: { percent: number; type: string };
}

interface CurrentConditions {
  temperature: Temperature;
  feelsLikeTemperature: Temperature;
  weatherCondition: WeatherCondition;
  relativeHumidity: number;
  wind: Wind;
  precipitation: Precipitation;
  uvIndex: number;
  isDaytime: boolean;
}

interface ForecastDay {
  displayDate: { year: number; month: number; day: number };
  maxTemperature: Temperature;
  minTemperature: Temperature;
  daytimeForecast: {
    weatherCondition: WeatherCondition;
    precipitation: Precipitation;
  };
}

interface ForecastResponse {
  forecastDays: ForecastDay[];
}

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

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Geocoding API error: ${res.status}`);
  }

  const data = await res.json() as {
    status: string;
    results: Array<{
      formatted_address: string;
      geometry: { location: { lat: number; lng: number } };
    }>;
  };

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

  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Weather API error ${res.status}: ${errText}`);
  }

  const data = await res.json() as CurrentConditions;

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

  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Forecast API error ${res.status}: ${errText}`);
  }

  const data = await res.json() as ForecastResponse;

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
