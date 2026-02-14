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
    // "recommend a restaurant in Cambridge" now routes to venues feature
    expect(matchFeature('recommend a restaurant in Cambridge')?.feature).toBe('venues');
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

  it('rejects bang commands', () => {
    expect(looksLikeIntroduction(
      '!weather in Boston today and tomorrow and the day after',
    )).toBe(false);
  });

  it('rejects casual conversation (the actual bug)', () => {
    // These were triggering false positives in the Introductions group
    expect(looksLikeIntroduction(
      'This bot is crazy…it sounds like a person 😟🤨',
    )).toBe(false);
    expect(looksLikeIntroduction(
      'It is too fast at responding to be a person tho 🤖',
    )).toBe(false);
    expect(looksLikeIntroduction(
      "Huh don't remember adding that feature to respond to just anything…",
    )).toBe(false);
    expect(looksLikeIntroduction(
      'do you have the feature suggestion feature yet?',
    )).toBe(false);
    expect(looksLikeIntroduction(
      'we might want to consider creeping out Rana less',
    )).toBe(false);
    expect(looksLikeIntroduction(
      'I am so proud of how this turned out honestly',
    )).toBe(false);
  });

  it('rejects messages with @mentions that lack intro signals', () => {
    expect(looksLikeIntroduction(
      '@11395269660682 do you have the feature suggestion feature yet?',
    )).toBe(false);
    expect(looksLikeIntroduction(
      '@11395269660682 well in the future I want you to take feature requests and bug reports from members',
    )).toBe(false);
  });

  it('rejects question-heavy messages', () => {
    expect(looksLikeIntroduction(
      'What time is the meetup? Where is it? Should I bring anything?',
    )).toBe(false);
    expect(looksLikeIntroduction(
      'Has anyone been to that new ramen place? Is it any good? How long is the wait usually?',
    )).toBe(false);
  });

  it('rejects welcome responses to other members intros', () => {
    expect(looksLikeIntroduction(
      "Welcome! So glad to have you here, you're going to love this community!",
    )).toBe(false);
    expect(looksLikeIntroduction(
      "Welcome to the group! We do hikes and board games most weekends.",
    )).toBe(false);
    expect(looksLikeIntroduction(
      "Glad you're here! You'll love the events we do around Boston.",
    )).toBe(false);
    expect(looksLikeIntroduction(
      "Great to have you! If you like board games you should check out the Hobbies group too.",
    )).toBe(false);
  });

  it('rejects messages just under the length threshold', () => {
    // 39 chars — just under the 40-char minimum
    expect(looksLikeIntroduction('Hi I am new here nice to meet everyone')).toBe(false);
  });

  it('accepts messages at the length threshold with intro signals', () => {
    // 40+ chars with strong intro signals (greeting + new here + nice to meet)
    expect(looksLikeIntroduction("Hi! I'm new here, nice to meet everyone!")).toBe(true);
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

// ── Event detection tests ───────────────────────────────────────────

describe('Event detection — detectEvent', async () => {
  const { detectEvent } = await import('../src/features/events.js');

  it('detects "let\'s do X on day" proposals', () => {
    const event = detectEvent("let's do trivia on Friday");
    expect(event).not.toBeNull();
    expect(event?.activity).toBe('trivia night');
    expect(event?.date).toBe('Friday');
  });

  it('detects "should we go to X this Saturday"', () => {
    const event = detectEvent('should we go to brunch this Saturday');
    expect(event).not.toBeNull();
    expect(event?.activity).toBe('brunch');
    expect(event?.date).toBe('this Saturday');
  });

  it('detects "anyone interested in X?"', () => {
    const event = detectEvent('anyone interested in a bar crawl next weekend?');
    expect(event).not.toBeNull();
    expect(event?.activity).toBe('bar crawl');
  });

  it('detects "anyone down for X?"', () => {
    const event = detectEvent('anyone down for bowling this Friday?');
    expect(event).not.toBeNull();
    expect(event?.activity).toBe('bowling');
  });

  it('detects "who wants to go to X?"', () => {
    const event = detectEvent('who wants to go to karaoke tomorrow night?');
    expect(event).not.toBeNull();
    expect(event?.activity).toBe('karaoke night');
  });

  it('detects direct activity + time patterns', () => {
    expect(detectEvent('trivia tonight at the pub')).not.toBeNull();
    expect(detectEvent('dinner at 7pm on Saturday')).not.toBeNull();
    expect(detectEvent('happy hour this Friday at 5')).not.toBeNull();
    expect(detectEvent('hike tomorrow morning in the Blue Hills')).not.toBeNull();
  });

  it('detects time + activity patterns', () => {
    const event = detectEvent('this Saturday night we should do karaoke');
    expect(event).not.toBeNull();
    expect(event?.activity).toBe('karaoke night');
  });

  it('detects explicit "event" and "meetup" keywords', () => {
    expect(detectEvent('event this Saturday at the park')).not.toBeNull();
    expect(detectEvent('meetup tomorrow at the usual spot')).not.toBeNull();
  });

  it('extracts time correctly', () => {
    const event = detectEvent("let's do dinner at 7pm this Friday");
    expect(event).not.toBeNull();
    expect(event?.time).toBe('7pm');
  });

  it('extracts time with colon', () => {
    const event = detectEvent("let's do dinner at 7:30pm this Friday");
    expect(event).not.toBeNull();
    expect(event?.time).toBe('7:30pm');
  });

  it('extracts date correctly', () => {
    const event = detectEvent('anyone interested in drinks tomorrow evening?');
    expect(event).not.toBeNull();
    expect(event?.date).toBe('tomorrow');
  });

  it('extracts "this/next + day" dates', () => {
    const event = detectEvent("let's plan a hike next Saturday morning");
    expect(event).not.toBeNull();
    expect(event?.date).toBe('next Saturday');
  });

  it('extracts location from "at Venue"', () => {
    const event = detectEvent("let's do trivia at Tavern on this Friday");
    expect(event).not.toBeNull();
    expect(event?.location).toBe('Tavern');
  });

  it('defaults activity to "event" when no specific type matched', () => {
    const event = detectEvent('anyone interested in going out next Friday?');
    expect(event).not.toBeNull();
    expect(event?.activity).toBe('event');
  });

  it('ignores short messages', () => {
    expect(detectEvent('trivia?')).toBeNull();
    expect(detectEvent('dinner soon')).toBeNull();
  });

  it('ignores non-event messages', () => {
    expect(detectEvent('The weather today is going to be awful for my commute')).toBeNull();
    expect(detectEvent('Has anyone seen the new season of that show?')).toBeNull();
    expect(detectEvent('I just had the best coffee at that new place on Newbury')).toBeNull();
  });

  it('preserves raw text in the result', () => {
    const msg = "let's do trivia at Harpoon on Friday at 7pm";
    const event = detectEvent(msg);
    expect(event?.rawText).toBe(msg);
  });
});

describe('Event detection — EVENTS_JID', async () => {
  const { EVENTS_JID } = await import('../src/features/events.js');

  it('resolves the Events group JID from config', () => {
    expect(EVENTS_JID).toBe('120363423189270382@g.us');
  });
});

describe('Event detection — feature router integration', async () => {
  const { matchFeature } = await import('../src/features/router.js');

  it('matches "plan a dinner" as events feature', () => {
    expect(matchFeature('plan a dinner this Saturday')?.feature).toBe('events');
  });

  it('matches "event this Friday" as events feature', () => {
    expect(matchFeature('event this Friday at the park')?.feature).toBe('events');
  });

  it('matches "let\'s do trivia" as events feature', () => {
    expect(matchFeature("let's do trivia this Saturday")?.feature).toBe('events');
  });

  it('matches "anyone down for" as events feature', () => {
    expect(matchFeature('anyone down for bowling?')?.feature).toBe('events');
  });

  it('does not match unrelated queries as events', () => {
    expect(matchFeature('what is the weather today')?.feature).toBe('weather');
    expect(matchFeature('tell me a joke')).toBeNull();
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

// ── Feedback feature tests ──────────────────────────────────────────

describe('Feedback — handleFeedbackSubmit', async () => {
  const { handleFeedbackSubmit } = await import('../src/features/feedback.js');

  it('submits a valid suggestion and returns response + owner alert', () => {
    const result = handleFeedbackSubmit(
      'suggestion',
      'Add a music recommendation feature based on group listening habits',
      '15551234567@s.whatsapp.net',
      '120363421084703266@g.us',
    );
    expect(result.response).toContain('Feature suggestion received');
    expect(result.response).toContain('#');
    expect(result.response).toContain('!upvote');
    expect(result.ownerAlert).not.toBeNull();
    expect(result.ownerAlert).toContain('New feature suggestion');
    expect(result.ownerAlert).toContain('music recommendation');
    expect(result.ownerAlert).toContain('Hobbies');
  });

  it('submits a valid bug report', () => {
    const result = handleFeedbackSubmit(
      'bug',
      'Bot responded to a normal message in Introductions that was not an introduction',
      '15559876543@s.whatsapp.net',
      '120363405986870419@g.us',
    );
    expect(result.response).toContain('Bug report received');
    expect(result.ownerAlert).toContain('New bug report');
    expect(result.ownerAlert).toContain('Introductions');
  });

  it('rejects empty description', () => {
    const result = handleFeedbackSubmit(
      'suggestion',
      '',
      '15551234567@s.whatsapp.net',
      '120363421084703266@g.us',
    );
    expect(result.response).toContain('Please include a description');
    expect(result.response).toContain('Example');
    expect(result.ownerAlert).toBeNull();
  });

  it('rejects too-short description', () => {
    const result = handleFeedbackSubmit(
      'bug',
      'broken',
      '15551234567@s.whatsapp.net',
      null,
    );
    expect(result.response).toContain('more detail');
    expect(result.ownerAlert).toBeNull();
  });

  it('works from DM (null groupJid)', () => {
    const result = handleFeedbackSubmit(
      'suggestion',
      'Let me configure my notification preferences for different groups',
      '15551234567@s.whatsapp.net',
      null,
    );
    expect(result.response).toContain('Feature suggestion received');
    expect(result.ownerAlert).toContain('DM');
  });
});

describe('Feedback — handleUpvote', async () => {
  const { handleUpvote } = await import('../src/features/feedback.js');
  const { submitFeedback, getOpenFeedback: _getOpenFeedback } = await import('../src/utils/db.js');

  it('upvotes an existing open item', () => {
    const entry = submitFeedback('suggestion', '15550000001@s.whatsapp.net', null, 'Test suggestion for upvoting');
    const result = handleUpvote(String(entry.id), '15550000002@s.whatsapp.net');
    expect(result).toContain('Upvoted');
    expect(result).toContain(`#${entry.id}`);
  });

  it('prevents duplicate upvotes from same user', () => {
    const entry = submitFeedback('suggestion', '15550000001@s.whatsapp.net', null, 'Another test suggestion for dedup');
    handleUpvote(String(entry.id), '15550000003@s.whatsapp.net');
    const result = handleUpvote(String(entry.id), '15550000003@s.whatsapp.net');
    expect(result).toContain('already upvoted');
  });

  it('rejects invalid ID', () => {
    const result = handleUpvote('abc', '15551234567@s.whatsapp.net');
    expect(result).toContain('Usage');
  });

  it('rejects nonexistent ID', () => {
    const result = handleUpvote('99999', '15551234567@s.whatsapp.net');
    expect(result).toContain('No feedback item found');
  });
});

describe('Feedback — handleFeedbackOwner', async () => {
  const { handleFeedbackOwner } = await import('../src/features/feedback.js');
  const { submitFeedback, setFeedbackStatus: _setFeedbackStatus } = await import('../src/utils/db.js');

  it('lists open items with no args', () => {
    // Items submitted in earlier tests should still be open
    const result = handleFeedbackOwner('');
    expect(result).toContain('Open feedback');
  });

  it('lists all items with "all" arg', () => {
    const result = handleFeedbackOwner('all');
    expect(result).toMatch(/feedback/i);
  });

  it('accepts an item', () => {
    const entry = submitFeedback('suggestion', '15550000010@s.whatsapp.net', null, 'Accept test suggestion item');
    const result = handleFeedbackOwner(`accept ${entry.id}`);
    expect(result).toContain('accepted');
    expect(result).toContain(`#${entry.id}`);
  });

  it('rejects an item', () => {
    const entry = submitFeedback('bug', '15550000010@s.whatsapp.net', null, 'Reject test bug report item');
    const result = handleFeedbackOwner(`reject ${entry.id}`);
    expect(result).toContain('rejected');
  });

  it('marks an item done', () => {
    const entry = submitFeedback('suggestion', '15550000010@s.whatsapp.net', null, 'Done test suggestion item here');
    const result = handleFeedbackOwner(`done ${entry.id}`);
    expect(result).toContain('done');
  });

  it('shows help for unknown subcommand', () => {
    const result = handleFeedbackOwner('foobar');
    expect(result).toContain('Feedback commands');
    expect(result).toContain('accept');
    expect(result).toContain('reject');
  });

  it('handles nonexistent ID gracefully', () => {
    const result = handleFeedbackOwner('accept 99999');
    expect(result).toContain('No feedback item found');
  });
});

describe('Feedback — router integration', async () => {
  const { matchFeature } = await import('../src/features/router.js');

  it('routes !suggest to feedback', () => {
    const match = matchFeature('!suggest Add dark mode');
    expect(match?.feature).toBe('feedback');
  });

  it('routes !bug to feedback', () => {
    const match = matchFeature('!bug Bot crashes on empty poll');
    expect(match?.feature).toBe('feedback');
  });

  it('routes !upvote to feedback', () => {
    const match = matchFeature('!upvote 5');
    expect(match?.feature).toBe('feedback');
  });

  it('routes !feedback to feedback', () => {
    const match = matchFeature('!feedback');
    expect(match?.feature).toBe('feedback');
  });
});
