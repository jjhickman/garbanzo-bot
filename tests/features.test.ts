import { describe, it, expect } from 'vitest';

describe('Feature router', async () => {
  const { matchFeature } = await import('../src/features/router.js');

  it('matches weather queries', () => {
    expect(matchFeature('what is the weather today')?.feature).toBe('weather');
    expect(matchFeature('forecast for this week')?.feature).toBe('weather');
    expect(matchFeature('how cold is it outside')?.feature).toBe('weather');
    expect(matchFeature('will it rain tomorrow')?.feature).toBe('weather');
    expect(matchFeature('temperature in Boston')?.feature).toBe('weather');
  });

  it('matches transit queries', () => {
    expect(matchFeature('is the red line running')?.feature).toBe('transit');
    expect(matchFeature('next train at Park Street')?.feature).toBe('transit');
    expect(matchFeature('any mbta delays today')?.feature).toBe('transit');
    expect(matchFeature('orange line status')?.feature).toBe('transit');
    expect(matchFeature('is the T running')?.feature).toBe('transit');
    expect(matchFeature('bus schedule')?.feature).toBe('transit');
    expect(matchFeature('shuttle service on blue line')?.feature).toBe('transit');
  });

  it('returns null for general queries', () => {
    expect(matchFeature('what is the meaning of life')).toBeNull();
    expect(matchFeature('recommend a restaurant in Cambridge')).toBeNull();
    expect(matchFeature('tell me a joke')).toBeNull();
  });

  it('preserves original query in match', () => {
    const match = matchFeature('weather in New York');
    expect(match?.query).toBe('weather in New York');
  });

  it('is case-insensitive', () => {
    expect(matchFeature('WEATHER TODAY')?.feature).toBe('weather');
    expect(matchFeature('Red Line delays')?.feature).toBe('transit');
  });
});
