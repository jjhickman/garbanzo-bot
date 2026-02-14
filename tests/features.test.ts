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

// ── Regex layer tests ──────────────────────────────────────────────
// These test the fast, synchronous pattern-based checks that run
// before any API call. No network needed.

describe('Content moderation — regex: hate speech / slurs', async () => {
  const { checkMessageRegex } = await import('../src/features/moderation.js');

  it('flags racial slurs', () => {
    const flag = checkMessageRegex('go back to your country you wetback');
    expect(flag).not.toBeNull();
    expect(flag?.severity).toBe('alert');
    expect(flag?.reason).toBe('Hate speech / slurs');
    expect(flag?.source).toBe('regex');
  });

  it('flags anti-LGBTQ slurs', () => {
    const flag = checkMessageRegex('test message with faggot slur');
    expect(flag).not.toBeNull();
    expect(flag?.severity).toBe('alert');
    expect(flag?.reason).toBe('Hate speech / slurs');
  });

  it('catches leet-speak evasion attempts', () => {
    // n1gger (1 substituted for i)
    expect(checkMessageRegex('you are a n1gger')).not.toBeNull();
    // f4ggot (4 substituted for a)
    expect(checkMessageRegex('what a f4ggot')).not.toBeNull();
  });

  it('flags "kill yourself" as hate speech', () => {
    expect(checkMessageRegex('just kill yourself already')).not.toBeNull();
    expect(checkMessageRegex('kill urself')).not.toBeNull();
  });

  it('does NOT flag non-slur uses of common words', () => {
    // "coon" in context of raccoon discussions
    // Note: this IS flagged by the current regex — documenting the false positive
    // If this becomes an issue, we rely on OpenAI to not flag it
    expect(checkMessageRegex('I saw a raccoon last night')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(checkMessageRegex('FAGGOT')).not.toBeNull();
    expect(checkMessageRegex('Wetback')).not.toBeNull();
  });
});

describe('Content moderation — regex: threats / violence', async () => {
  const { checkMessageRegex } = await import('../src/features/moderation.js');

  it('flags direct death threats', () => {
    const flag = checkMessageRegex("I'll kill you for that");
    expect(flag).not.toBeNull();
    expect(flag?.severity).toBe('alert');
    expect(flag?.reason).toBe('Threats / violence');
  });

  it('flags threats with various verb forms', () => {
    expect(checkMessageRegex("I will murder you")).not.toBeNull();
    expect(checkMessageRegex("I'm gonna shoot you")).not.toBeNull();
    expect(checkMessageRegex("I'm going to stab you")).not.toBeNull();
    expect(checkMessageRegex("I'll beat you up")).not.toBeNull();
  });

  it('flags threats with generic targets', () => {
    expect(checkMessageRegex('I will kill someone tomorrow')).not.toBeNull();
    expect(checkMessageRegex('gonna murder everybody here')).not.toBeNull();
    expect(checkMessageRegex('I will stab anyone who disagrees')).not.toBeNull();
    expect(checkMessageRegex('shoot him on sight')).not.toBeNull();
    expect(checkMessageRegex('stab her if she shows up')).not.toBeNull();
  });

  it('flags "you are dead" style threats', () => {
    expect(checkMessageRegex("you're dead meat")).not.toBeNull();
    expect(checkMessageRegex("you are gonna die")).not.toBeNull();
  });

  it('flags doxxing and swatting', () => {
    expect(checkMessageRegex("I'm doxxing you tonight")).not.toBeNull();
    expect(checkMessageRegex("someone got swatted yesterday")).not.toBeNull();
    expect(checkMessageRegex("gonna dox this guy")).not.toBeNull();
  });

  it('does NOT flag casual uses of violence words', () => {
    expect(checkMessageRegex('that comedian killed it last night')).toBeNull();
    expect(checkMessageRegex('I murdered that exam')).toBeNull();
    expect(checkMessageRegex('this song is a banger, absolute killer')).toBeNull();
  });
});

describe('Content moderation — regex: spam / self-promotion', async () => {
  const { checkMessageRegex } = await import('../src/features/moderation.js');

  it('flags crypto spam', () => {
    const flag = checkMessageRegex('Buy bitcoin now for guaranteed income!');
    expect(flag).not.toBeNull();
    expect(flag?.severity).toBe('warning');
    expect(flag?.reason).toBe('Spam / self-promotion');
  });

  it('flags investment scam language', () => {
    expect(checkMessageRegex('guaranteed income with zero risk')).not.toBeNull();
    expect(checkMessageRegex('passive income from home')).not.toBeNull();
    expect(checkMessageRegex('invest crypto today for free')).not.toBeNull();
  });

  it('flags DM-for-money schemes', () => {
    expect(checkMessageRegex('DM me to earn big bucks')).not.toBeNull();
    expect(checkMessageRegex('message me for make money online')).not.toBeNull();
  });

  it('flags link dumping (3+ URLs)', () => {
    const links = 'Check out https://a.com and https://b.com and https://c.com';
    expect(checkMessageRegex(links)).not.toBeNull();
  });

  it('does NOT flag normal link sharing (1-2 URLs)', () => {
    expect(checkMessageRegex('Check out https://cool-restaurant.com')).toBeNull();
    expect(checkMessageRegex('Here: https://a.com and https://b.com')).toBeNull();
  });

  it('does NOT flag normal crypto discussion', () => {
    expect(checkMessageRegex('what do you think about bitcoin these days?')).toBeNull();
    expect(checkMessageRegex('crypto market is wild right now')).toBeNull();
  });
});

describe('Content moderation — regex: personal info sharing', async () => {
  const { checkMessageRegex } = await import('../src/features/moderation.js');

  it('flags SSN-like patterns', () => {
    const flag = checkMessageRegex('his SSN is 123-45-6789');
    expect(flag).not.toBeNull();
    expect(flag?.severity).toBe('warning');
    expect(flag?.reason).toBe('Personal info sharing');
  });

  it('flags sharing someone else\'s phone number', () => {
    expect(checkMessageRegex('his number is 555-1234')).not.toBeNull();
    expect(checkMessageRegex('her phone is 617-555-0199')).not.toBeNull();
    expect(checkMessageRegex('their cell is 781-555-0100')).not.toBeNull();
  });

  it('flags sharing someone\'s address', () => {
    expect(checkMessageRegex('she lives at 123 Main Street')).not.toBeNull();
    expect(checkMessageRegex('his address is 456 Oak Ave')).not.toBeNull();
  });

  it('does NOT flag sharing your own info', () => {
    // "my number is" is fine — only flags "his/her/their"
    expect(checkMessageRegex('my number is 555-1234')).toBeNull();
    expect(checkMessageRegex('call me at 617-555-0199')).toBeNull();
  });
});

describe('Content moderation — regex: safe content (no false positives)', async () => {
  const { checkMessageRegex } = await import('../src/features/moderation.js');

  it('allows normal conversation', () => {
    expect(checkMessageRegex('Hey anyone want to grab dinner tonight?')).toBeNull();
    expect(checkMessageRegex('The weather is terrible today')).toBeNull();
    expect(checkMessageRegex('Has anyone been to that new bar in Somerville?')).toBeNull();
    expect(checkMessageRegex('Who is coming to the meetup on Saturday?')).toBeNull();
  });

  it('allows casual profanity', () => {
    expect(checkMessageRegex('That restaurant was shit')).toBeNull();
    expect(checkMessageRegex('What the hell is going on')).toBeNull();
    expect(checkMessageRegex('Holy crap that was amazing')).toBeNull();
    expect(checkMessageRegex('Damn that movie was good')).toBeNull();
    expect(checkMessageRegex('This weather is ass')).toBeNull();
  });

  it('allows discussion of sensitive topics without violations', () => {
    expect(checkMessageRegex('The news about that shooting was tragic')).toBeNull();
    expect(checkMessageRegex('There was a stabbing reported downtown')).toBeNull();
    expect(checkMessageRegex('I hate when the T is delayed')).toBeNull();
  });

  it('allows adult humor and topics', () => {
    expect(checkMessageRegex('That joke was so dirty lmao')).toBeNull();
    expect(checkMessageRegex('Anyone want to hit up a bar crawl?')).toBeNull();
    expect(checkMessageRegex('I got so wasted last weekend')).toBeNull();
  });
});

// ── Combined async layer tests ─────────────────────────────────────
// These test the full checkMessage() pipeline. In test env, no
// OPENAI_API_KEY is set, so the OpenAI layer is a no-op.

describe('Content moderation — combined (async)', async () => {
  const { checkMessage } = await import('../src/features/moderation.js');

  it('returns a promise', () => {
    const result = checkMessage('hello');
    expect(result).toBeInstanceOf(Promise);
  });

  it('regex flags are returned with source=regex', async () => {
    const flag = await checkMessage('test message with faggot slur');
    expect(flag).not.toBeNull();
    expect(flag?.source).toBe('regex');
    expect(flag?.severity).toBe('alert');
  });

  it('resolves to null for safe messages (no OPENAI_API_KEY in test env)', async () => {
    expect(await checkMessage('Hey anyone want to grab dinner tonight?')).toBeNull();
    expect(await checkMessage('The weather is terrible today')).toBeNull();
    expect(await checkMessage('Damn that movie was good')).toBeNull();
  });

  it('flags all regex categories through the async pipeline', async () => {
    // Hate speech
    const hate = await checkMessage('you are a n1gger');
    expect(hate?.reason).toBe('Hate speech / slurs');

    // Threats
    const threat = await checkMessage("I'll kill you for that");
    expect(threat?.reason).toBe('Threats / violence');

    // Spam
    const spam = await checkMessage('Buy bitcoin now for guaranteed income!');
    expect(spam?.reason).toBe('Spam / self-promotion');

    // PII
    const pii = await checkMessage('his number is 555-1234');
    expect(pii?.reason).toBe('Personal info sharing');
  });
});

// ── Alert formatting tests ─────────────────────────────────────────

describe('Content moderation — alert formatting', async () => {
  const { formatModerationAlert } = await import('../src/features/moderation.js');
  type ModerationFlag = import('../src/features/moderation.js').ModerationFlag;

  it('formats alert-severity flags correctly', () => {
    const flag: ModerationFlag = {
      reason: 'Hate speech / slurs',
      severity: 'alert',
      source: 'regex',
    };
    const alert = formatModerationAlert(flag, 'some bad message', '15551234567@s.whatsapp.net', '120363423357339667@g.us');

    expect(alert).toContain('ALERT');
    expect(alert).toContain('Hate speech / slurs');
    expect(alert).toContain('[Pattern]');
    expect(alert).toContain('15551234567');
    expect(alert).toContain('some bad message');
    expect(alert).toContain('no action has been taken');
  });

  it('formats warning-severity flags correctly', () => {
    const flag: import('../src/features/moderation.js').ModerationFlag = {
      reason: 'Spam / self-promotion',
      severity: 'warning',
      source: 'regex',
    };
    const alert = formatModerationAlert(flag, 'buy crypto now', '15559876543@s.whatsapp.net', '120363423357339667@g.us');

    expect(alert).toContain('Warning');
    expect(alert).not.toContain('ALERT');
    expect(alert).toContain('Spam / self-promotion');
  });

  it('shows [AI] label for OpenAI-sourced flags', () => {
    const flag: import('../src/features/moderation.js').ModerationFlag = {
      reason: 'Harassment (AI-detected)',
      severity: 'alert',
      source: 'openai',
    };
    const alert = formatModerationAlert(flag, 'some harassing message', '15551234567@s.whatsapp.net', '120363423357339667@g.us');

    expect(alert).toContain('[AI]');
    expect(alert).not.toContain('[Pattern]');
  });

  it('truncates long messages to 200 chars', () => {
    const flag: import('../src/features/moderation.js').ModerationFlag = {
      reason: 'Threats / violence',
      severity: 'alert',
      source: 'regex',
    };
    const longMessage = 'a'.repeat(300);
    const alert = formatModerationAlert(flag, longMessage, '15551234567@s.whatsapp.net', '120363423357339667@g.us');

    expect(alert).toContain('...');
    expect(alert).not.toContain('a'.repeat(300));
  });
});

// ── Introductions feature tests ─────────────────────────────────────

describe('Introduction detection — looksLikeIntroduction', async () => {
  const { looksLikeIntroduction } = await import('../src/features/introductions.js');

  it('recognizes a typical introduction', () => {
    expect(looksLikeIntroduction(
      "Hey everyone! I'm Sarah, 28, just moved to Boston from Chicago. I'm into hiking, board games, and trying new restaurants. Excited to meet people!",
    )).toBe(true);
  });

  it('recognizes a minimal but valid intro', () => {
    expect(looksLikeIntroduction(
      "Hi I'm Mike, 32, living in Somerville. Love music and cooking.",
    )).toBe(true);
  });

  it('recognizes an intro with interests and hobbies', () => {
    expect(looksLikeIntroduction(
      "What's up! Name's Alex, from Dorchester. Big Celtics fan, play guitar on weekends, and always looking for good ramen spots.",
    )).toBe(true);
  });

  it('recognizes a longer personal intro', () => {
    expect(looksLikeIntroduction(
      "Hey y'all! I'm Priya, 30, moved to Cambridge last year for grad school at MIT. Originally from Texas. I like rock climbing, reading sci-fi, and exploring the food scene here. Found this group through a friend and thought it'd be a great way to meet people outside of school. Looking forward to some events!",
    )).toBe(true);
  });

  it('rejects short messages that are not intros', () => {
    expect(looksLikeIntroduction('hi')).toBe(false);
    expect(looksLikeIntroduction('thanks!')).toBe(false);
    expect(looksLikeIntroduction('welcome!')).toBe(false);
    expect(looksLikeIntroduction('lol nice')).toBe(false);
    expect(looksLikeIntroduction('Hey what time is the meetup?')).toBe(false);
  });

  it('rejects bot commands', () => {
    expect(looksLikeIntroduction(
      '@garbanzo what is the weather today in Boston and should I bring an umbrella?',
    )).toBe(false);
    expect(looksLikeIntroduction(
      '@bot tell me about the next event this weekend and who is going',
    )).toBe(false);
  });

  it('rejects messages just under the length threshold', () => {
    // 39 chars — just under the 40-char minimum
    expect(looksLikeIntroduction('Hi I am new here nice to meet everyone')).toBe(false);
  });

  it('accepts messages at the length threshold', () => {
    // Exactly 40 chars
    expect(looksLikeIntroduction('Hi I am new here, nice to meet everyone!')).toBe(true);
  });
});

describe('Introduction detection — INTRODUCTIONS_JID', async () => {
  const { INTRODUCTIONS_JID } = await import('../src/features/introductions.js');

  it('resolves the Introductions group JID from config', () => {
    expect(INTRODUCTIONS_JID).toBe('120363405986870419@g.us');
  });
});

describe('Introduction detection — INTRO_SYSTEM_ADDENDUM', async () => {
  const { INTRO_SYSTEM_ADDENDUM } = await import('../src/features/introductions.js');

  it('contains key instructions for AI intro responses', () => {
    expect(INTRO_SYSTEM_ADDENDUM).toContain('welcome them warmly');
    expect(INTRO_SYSTEM_ADDENDUM).toContain('something specific they mentioned');
    expect(INTRO_SYSTEM_ADDENDUM).toContain('2-4 sentences');
    expect(INTRO_SYSTEM_ADDENDUM).toContain('Do NOT use a template');
  });
});

describe('Persona — intro-specific prompt injection', async () => {
  const { buildSystemPrompt } = await import('../src/ai/persona.js');

  it('includes intro addendum for Introductions group', () => {
    const prompt = buildSystemPrompt({
      groupName: 'Introductions',
      groupJid: '120363405986870419@g.us',
      senderJid: '15551234567@s.whatsapp.net',
    });
    expect(prompt).toContain('welcome them warmly');
    expect(prompt).toContain('SPECIAL CONTEXT');
  });

  it('does NOT include intro addendum for other groups', () => {
    const prompt = buildSystemPrompt({
      groupName: 'General',
      groupJid: '120363423357339667@g.us',
      senderJid: '15551234567@s.whatsapp.net',
    });
    expect(prompt).not.toContain('welcome them warmly');
    expect(prompt).not.toContain('SPECIAL CONTEXT');
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
