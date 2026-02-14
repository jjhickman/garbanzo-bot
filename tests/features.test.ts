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

  it('matches news queries', () => {
    expect(matchFeature('news about Boston')?.feature).toBe('news');
    expect(matchFeature('top headlines')?.feature).toBe('news');
    expect(matchFeature('what is happening in the world')?.feature).toBe('news');
    expect(matchFeature('current events')?.feature).toBe('news');
  });

  it('matches help queries', () => {
    expect(matchFeature('help')?.feature).toBe('help');
    expect(matchFeature('what can you do')?.feature).toBe('help');
    expect(matchFeature('commands')?.feature).toBe('help');
    expect(matchFeature('features')?.feature).toBe('help');
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
    expect(matchFeature('NEWS about tech')?.feature).toBe('news');
  });
});

describe('Content moderation', async () => {
  const { checkMessage } = await import('../src/features/moderation.js');

  it('flags hate speech', () => {
    const flag = checkMessage('you are a f*ggot');  // asterisk to avoid literal slur in test
    // This won't match because of the asterisk — test with the pattern directly
    const flag2 = checkMessage('test message with faggot slur');
    expect(flag2).not.toBeNull();
    expect(flag2?.severity).toBe('alert');
    expect(flag2?.reason).toBe('Hate speech / slurs');
  });

  it('flags threats', () => {
    const flag = checkMessage("I'll kill you for that");
    expect(flag).not.toBeNull();
    expect(flag?.severity).toBe('alert');
    expect(flag?.reason).toBe('Threats / violence');
  });

  it('flags threats with generic targets', () => {
    expect(checkMessage('I will kill someone tomorrow')).not.toBeNull();
    expect(checkMessage('gonna murder everybody here')).not.toBeNull();
    expect(checkMessage('I will stab anyone who disagrees')).not.toBeNull();
  });

  it('flags spam patterns', () => {
    const flag = checkMessage('Buy bitcoin now for guaranteed income!');
    expect(flag).not.toBeNull();
    expect(flag?.severity).toBe('warning');
    expect(flag?.reason).toBe('Spam / self-promotion');
  });

  it('ignores normal messages', () => {
    expect(checkMessage('Hey anyone want to grab dinner tonight?')).toBeNull();
    expect(checkMessage('The weather is terrible today')).toBeNull();
    expect(checkMessage('Damn that movie was good')).toBeNull();
  });

  it('allows casual profanity', () => {
    expect(checkMessage('That restaurant was shit')).toBeNull();
    expect(checkMessage('What the hell is going on')).toBeNull();
    expect(checkMessage('Holy crap that was amazing')).toBeNull();
  });
});

describe('Welcome messages', async () => {
  const { buildWelcomeMessage } = await import('../src/features/welcome.js');

  it('generates welcome for known group', () => {
    const msg = buildWelcomeMessage(
      '120363423357339667@g.us',  // General group
      ['15551234567@s.whatsapp.net'],
    );
    expect(msg).not.toBeNull();
    expect(msg).toContain('General');
    expect(msg).toContain('@15551234567');
  });

  it('handles multiple new members', () => {
    const msg = buildWelcomeMessage(
      '120363423357339667@g.us',
      ['15551234567@s.whatsapp.net', '15559876543@s.whatsapp.net'],
    );
    expect(msg).toContain('all 2 of you');
  });

  it('returns null for unknown groups', () => {
    const msg = buildWelcomeMessage('unknown@g.us', ['15551234567@s.whatsapp.net']);
    expect(msg).toBeNull();
  });

  it('tailors message per group', () => {
    const intro = buildWelcomeMessage(
      '120363405986870419@g.us',  // Introductions
      ['15551234567@s.whatsapp.net'],
    );
    expect(intro).toContain('Introductions');
    expect(intro).toContain('Tell us a bit about yourself');
  });
});
