import { describe, it, expect } from 'vitest';

function must<T>(value: T | null | undefined, message: string = 'expected value'): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

// ═══════════════════════════════════════════════════════════════════
// 1. BANG COMMAND ROUTING
// ═══════════════════════════════════════════════════════════════════
// Tests that every !command prefix routes to the correct feature
// and strips the prefix correctly.

describe('Bang command routing', async () => {
  const { matchFeature } = await import('../src/features/router.js');

  it('routes !weather to weather feature', () => {
    const match = matchFeature('!weather Boston');
    expect(match?.feature).toBe('weather');
    expect(match?.query).toBe('Boston');
  });

  it('routes !forecast to weather feature', () => {
    const match = matchFeature('!forecast this week');
    expect(match?.feature).toBe('weather');
    expect(match?.query).toBe('this week');
  });

  it('routes !transit to transit feature', () => {
    const match = matchFeature('!transit red line');
    expect(match?.feature).toBe('transit');
    expect(match?.query).toBe('red line');
  });

  it('routes !mbta to transit feature', () => {
    expect(matchFeature('!mbta delays')?.feature).toBe('transit');
  });

  it('routes !train and !bus to transit', () => {
    expect(matchFeature('!train Park Street')?.feature).toBe('transit');
    expect(matchFeature('!bus 66')?.feature).toBe('transit');
  });

  it('routes !news to news feature', () => {
    const match = matchFeature('!news tech');
    expect(match?.feature).toBe('news');
    expect(match?.query).toBe('tech');
  });

  it('routes !help to help feature', () => {
    const match = matchFeature('!help');
    expect(match?.feature).toBe('help');
  });

  it('routes !events and !plan to events feature', () => {
    expect(matchFeature('!events')?.feature).toBe('events');
    expect(matchFeature('!plan trivia Friday')?.feature).toBe('events');
  });

  it('routes !roll to roll feature', () => {
    const match = matchFeature('!roll 2d6+3');
    expect(match?.feature).toBe('roll');
    expect(match?.query).toBe('2d6+3');
  });

  it('routes !dice to roll feature', () => {
    expect(matchFeature('!dice d20')?.feature).toBe('roll');
  });

  it('routes !dnd to dnd feature', () => {
    const match = matchFeature('!dnd spell fireball');
    expect(match?.feature).toBe('dnd');
    expect(match?.query).toBe('spell fireball');
  });

  it('routes !spell and !monster to dnd feature', () => {
    expect(matchFeature('!spell fireball')?.feature).toBe('dnd');
    expect(matchFeature('!monster goblin')?.feature).toBe('dnd');
  });

  it('routes !book and !books and !read to books feature', () => {
    expect(matchFeature('!book dune')?.feature).toBe('books');
    expect(matchFeature('!books author herbert')?.feature).toBe('books');
    expect(matchFeature('!read sci-fi')?.feature).toBe('books');
  });

  it('routes !venue, !venues, !find, !place to venues feature', () => {
    expect(matchFeature('!venue bars in somerville')?.feature).toBe('venues');
    expect(matchFeature('!venues escape rooms')?.feature).toBe('venues');
    expect(matchFeature('!find bowling')?.feature).toBe('venues');
    expect(matchFeature('!place coffee near me')?.feature).toBe('venues');
  });

  it('routes !poll and !vote to poll feature', () => {
    expect(matchFeature('!poll What day? / Friday / Saturday')?.feature).toBe('poll');
    expect(matchFeature('!vote something')?.feature).toBe('poll');
  });

  it('routes !trivia to fun with subcommand preserved', () => {
    const match = matchFeature('!trivia science');
    expect(match?.feature).toBe('fun');
    expect(match?.query).toBe('trivia science');
  });

  it('routes !fact to fun with subcommand preserved', () => {
    const match = matchFeature('!fact');
    expect(match?.feature).toBe('fun');
    expect(match?.query).toBe('fact');
  });

  it('routes !today to fun with subcommand preserved', () => {
    const match = matchFeature('!today');
    expect(match?.feature).toBe('fun');
    expect(match?.query).toBe('today');
  });

  it('routes !icebreaker and !ice to fun with subcommand', () => {
    expect(matchFeature('!icebreaker')?.query).toBe('icebreaker');
    expect(matchFeature('!ice')?.query).toBe('ice');
  });

  it('routes !fun to fun feature', () => {
    expect(matchFeature('!fun')?.feature).toBe('fun');
  });

  it('strips the bang prefix from the query', () => {
    expect(matchFeature('!weather Boston MA')?.query).toBe('Boston MA');
    expect(matchFeature('!transit red line status')?.query).toBe('red line status');
    expect(matchFeature('!dnd monster goblin')?.query).toBe('monster goblin');
  });

  it('handles bang commands with no arguments', () => {
    // For non-fun commands, empty args should use the full trimmed input
    const match = matchFeature('!help');
    expect(match).not.toBeNull();
    expect(match?.feature).toBe('help');
  });

  it('does not match unknown bang commands', () => {
    expect(matchFeature('!nonexistent something')).toBeNull();
    expect(matchFeature('!foo bar')).toBeNull();
  });

  it('is case-insensitive for bang commands', () => {
    // Bang commands use toLowerCase on the first word
    expect(matchFeature('!WEATHER Boston')?.feature).toBe('weather');
    expect(matchFeature('!Roll d20')?.feature).toBe('roll');
    expect(matchFeature('!DND spell fireball')?.feature).toBe('dnd');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. AI COMPLEXITY CLASSIFIER
// ═══════════════════════════════════════════════════════════════════
// Tests that classifyComplexity routes the right queries to
// Ollama (simple) vs Claude (complex).

describe('AI complexity classifier', async () => {
  const { classifyComplexity } = await import('../src/ai/router.js');

  // Helper — default context for a generic group
  const defaultCtx = {
    groupName: 'General',
    groupJid: '120363423357339667@g.us',
    senderJid: '15551234567@s.whatsapp.net',
  };

  // ── Group-based routing ────────────────────────────────────────

  it('routes Introductions group to complex (Claude)', () => {
    expect(classifyComplexity('hey everyone', {
      ...defaultCtx,
      groupName: 'Introductions',
      groupJid: '120363405986870419@g.us',
    })).toBe('complex');
  });

  it('routes Events group to complex (Claude)', () => {
    expect(classifyComplexity('hey everyone', {
      ...defaultCtx,
      groupName: 'Events',
      groupJid: '120363423189270382@g.us',
    })).toBe('complex');
  });

  it('does NOT force complex for other groups', () => {
    // A short greeting in General should be simple
    expect(classifyComplexity('hey', defaultCtx)).toBe('simple');
  });

  // ── Quoted messages ────────────────────────────────────────────

  it('routes quoted replies to complex (needs context)', () => {
    expect(classifyComplexity('I agree with that', {
      ...defaultCtx,
      quotedText: 'Some previous message',
    })).toBe('complex');
  });

  // ── Context-dependent queries ─────────────────────────────────

  it('routes "what did I just say" to complex', () => {
    expect(classifyComplexity('what did I just say', defaultCtx)).toBe('complex');
  });

  it('routes "you said" references to complex', () => {
    expect(classifyComplexity('wait you said something different earlier', defaultCtx)).toBe('complex');
  });

  it('routes "we said" to complex', () => {
    expect(classifyComplexity('we said we would do trivia', defaultCtx)).toBe('complex');
  });

  it('routes "recap" and "summarize" to complex', () => {
    expect(classifyComplexity('can you recap that conversation', defaultCtx)).toBe('complex');
    expect(classifyComplexity('summarize what just happened', defaultCtx)).toBe('complex');
  });

  it('routes "just mentioned" to complex', () => {
    expect(classifyComplexity('you just mentioned a restaurant', defaultCtx)).toBe('complex');
  });

  it('routes "earlier" and "before" references to complex', () => {
    expect(classifyComplexity('what was that place you mentioned earlier', defaultCtx)).toBe('complex');
    expect(classifyComplexity('like I said before about the weather', defaultCtx)).toBe('complex');
  });

  // ── Short messages → simple ───────────────────────────────────

  it('routes very short messages to simple', () => {
    expect(classifyComplexity('hey', defaultCtx)).toBe('simple');
    expect(classifyComplexity('yo', defaultCtx)).toBe('simple');
    expect(classifyComplexity('thanks', defaultCtx)).toBe('simple');
    expect(classifyComplexity('lol', defaultCtx)).toBe('simple');
  });

  // ── Long messages → complex ───────────────────────────────────

  it('routes long messages (150+ chars) to complex', () => {
    const long = 'I was wondering if you could help me understand the difference between the red line and the orange line schedules, because I need to get from Harvard to Downtown Crossing during rush hour and want the fastest option.';
    expect(long.length).toBeGreaterThan(150);
    expect(classifyComplexity(long, defaultCtx)).toBe('complex');
  });

  // ── Greeting patterns → simple ────────────────────────────────

  it('routes greetings to simple', () => {
    expect(classifyComplexity('hey there Garbanzo', defaultCtx)).toBe('simple');
    expect(classifyComplexity('hello how are you', defaultCtx)).toBe('simple');
    expect(classifyComplexity('good morning everyone', defaultCtx)).toBe('simple');
    expect(classifyComplexity('yo whats up', defaultCtx)).toBe('simple');
    expect(classifyComplexity('sup Garbanzo', defaultCtx)).toBe('simple');
  });

  // ── Simple question patterns ──────────────────────────────────

  it('routes simple factual questions to simple', () => {
    expect(classifyComplexity('what is the time', defaultCtx)).toBe('simple');
    expect(classifyComplexity('where is the nearest bar', defaultCtx)).toBe('simple');
    expect(classifyComplexity('who is the mayor of Boston', defaultCtx)).toBe('simple');
    expect(classifyComplexity('when does the T close', defaultCtx)).toBe('simple');
  });

  it('routes multi-clause questions to complex', () => {
    // Question mark not at the end signals multiple questions
    expect(classifyComplexity('what is the time? also where is the bar?', defaultCtx)).toBe('complex');
  });

  // ── "Tell me" / opinion → simple if short ─────────────────────

  it('routes short "tell me" queries to simple', () => {
    expect(classifyComplexity('tell me a fun fact', defaultCtx)).toBe('simple');
    expect(classifyComplexity('recommend a restaurant', defaultCtx)).toBe('simple');
    expect(classifyComplexity('suggest something to do', defaultCtx)).toBe('simple');
  });

  // ── Acknowledgments → simple ──────────────────────────────────

  it('routes acknowledgments to simple', () => {
    expect(classifyComplexity('thanks for the info', defaultCtx)).toBe('simple');
    expect(classifyComplexity('cool, got it', defaultCtx)).toBe('simple');
    expect(classifyComplexity('nice', defaultCtx)).toBe('simple');
    expect(classifyComplexity('ok makes sense', defaultCtx)).toBe('simple');
  });

  // ── Complex connectors → complex ──────────────────────────────

  it('routes comparison/explanation requests to complex', () => {
    expect(classifyComplexity('explain the difference between ales and lagers', defaultCtx)).toBe('complex');
    expect(classifyComplexity('compare the red line versus the orange line', defaultCtx)).toBe('complex');
    expect(classifyComplexity('however I think the old system was better', defaultCtx)).toBe('complex');
  });

  // ── Multi-sentence → complex ──────────────────────────────────

  it('routes multi-sentence messages to complex', () => {
    expect(classifyComplexity('I went to the bar. It was great. Then we left. What do you think?', defaultCtx)).toBe('complex');
  });

  // ── Medium length, no signals → default simple ────────────────

  it('defaults medium-length messages without signals to simple', () => {
    // Under 100 chars, no complex connectors
    expect(classifyComplexity('best pizza place near Harvard Square right now', defaultCtx)).toBe('simple');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. PHASE 4 FEATURE UNIT TESTS
// ═══════════════════════════════════════════════════════════════════

// ── 3a. D&D Dice Roller ─────────────────────────────────────────

describe('D&D dice roller — rollDice', async () => {
  const { rollDice } = await import('../src/features/dnd.js');

  it('parses a simple d20', () => {
    const result = must(rollDice('d20'), 'expected d20 result');
    expect(result.rolls).toHaveLength(1);
    expect(result.rolls[0]).toBeGreaterThanOrEqual(1);
    expect(result.rolls[0]).toBeLessThanOrEqual(20);
    expect(result.modifier).toBe(0);
    expect(result.total).toBe(result.rolls[0]);
  });

  it('parses 2d6', () => {
    const result = must(rollDice('2d6'), 'expected 2d6 result');
    expect(result.rolls).toHaveLength(2);
    for (const r of result.rolls) {
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(6);
    }
    expect(result.total).toBe(result.rolls[0] + result.rolls[1]);
  });

  it('parses modifier: 2d6+3', () => {
    const result = must(rollDice('2d6+3'), 'expected 2d6+3 result');
    expect(result.modifier).toBe(3);
    expect(result.total).toBe(result.rolls[0] + result.rolls[1] + 3);
  });

  it('parses negative modifier: 4d8-1', () => {
    const result = must(rollDice('4d8-1'), 'expected 4d8-1 result');
    expect(result.modifier).toBe(-1);
    expect(result.rolls).toHaveLength(4);
  });

  it('parses d100 (percentile)', () => {
    const result = must(rollDice('d100'), 'expected d100 result');
    expect(result.rolls[0]).toBeGreaterThanOrEqual(1);
    expect(result.rolls[0]).toBeLessThanOrEqual(100);
  });

  it('rejects invalid notation', () => {
    expect(rollDice('hello')).toBeNull();
    expect(rollDice('dtwenty')).toBeNull();
    expect(rollDice('roll')).toBeNull();
    expect(rollDice('')).toBeNull();
  });

  it('rejects out-of-range dice (count > 100 or sides > 1000)', () => {
    expect(rollDice('101d6')).toBeNull();
    expect(rollDice('1d1001')).toBeNull();
  });

  it('rejects d1 (sides < 2)', () => {
    expect(rollDice('d1')).toBeNull();
  });

  it('handles leading whitespace', () => {
    const result = rollDice('  d20  ');
    expect(result).not.toBeNull();
  });

  it('is case-insensitive', () => {
    expect(rollDice('D20')).not.toBeNull();
    expect(rollDice('2D6+3')).not.toBeNull();
  });
});

describe('D&D dice roller — formatRoll', async () => {
  const dnd = await import('../src/features/dnd.js');
  const formatRoll = dnd.formatRoll;
  type RollResult = import('../src/features/dnd.js').RollResult;

  it('formats a single die roll', () => {
    const result: RollResult = { notation: 'd20', rolls: [15], modifier: 0, total: 15 };
    const formatted = formatRoll(result);
    expect(formatted).toContain('d20');
    expect(formatted).toContain('15');
  });

  it('formats multiple dice with modifier', () => {
    const result: RollResult = { notation: '2d6+3', rolls: [4, 5], modifier: 3, total: 12 };
    const formatted = formatRoll(result);
    expect(formatted).toContain('2d6+3');
    expect(formatted).toContain('12');
    expect(formatted).toContain('4, 5');
    expect(formatted).toContain('+ 3');
  });

  it('formats negative modifier', () => {
    const result: RollResult = { notation: '2d6-1', rolls: [3, 4], modifier: -1, total: 6 };
    const formatted = formatRoll(result);
    expect(formatted).toContain('- 1');
  });
});

describe('D&D handler — handleDnd routing', async () => {
  const { handleDnd } = await import('../src/features/dnd.js');

  it('returns help when called with empty string', async () => {
    const result = await handleDnd('');
    expect(result).toContain('D&D 5e Commands');
    expect(result).toContain('!roll');
    expect(result).toContain('!dnd spell');
  });

  it('rolls dice for notation input', async () => {
    const result = await handleDnd('d20');
    expect(result).toContain('d20');
    // Should contain a dice emoji
    expect(result).toMatch(/🎲/);
  });

  it('rolls multiple dice', async () => {
    const result = await handleDnd('2d6 d20');
    // Should have two roll results
    expect(result.match(/🎲/g)?.length).toBe(2);
  });

  it('returns error for invalid dice notation', async () => {
    const result = await handleDnd('d0');
    // d0 has 0 sides which is < 2, so it should fail
    expect(result).toContain('Invalid dice notation');
  });
});

// ── 3b. Polls ───────────────────────────────────────────────────

describe('Polls — parsePoll', async () => {
  const { parsePoll } = await import('../src/features/polls.js');

  it('parses slash-separated format', () => {
    const poll = must(parsePoll('What day? / Friday / Saturday / Sunday'), 'expected poll');
    expect(poll.name).toBe('What day?');
    expect(poll.values).toEqual(['Friday', 'Saturday', 'Sunday']);
    expect(poll.selectableCount).toBe(1);
  });

  it('parses quoted format', () => {
    const poll = must(parsePoll('"Best pizza?" "Regina" "Santarpio" "Pepe\'s"'), 'expected poll');
    expect(poll.name).toBe('Best pizza?');
    expect(poll.values).toEqual(['Regina', 'Santarpio', "Pepe's"]);
  });

  it('parses newline-separated format', () => {
    const poll = must(parsePoll('Best brunch spot?\nTiku\nSalted Pig\nMike\'s'), 'expected poll');
    expect(poll.name).toBe('Best brunch spot?');
    expect(poll.values).toHaveLength(3);
  });

  it('appends ? to question if missing', () => {
    const poll = must(parsePoll('Favorite color / Red / Blue / Green'), 'expected poll');
    expect(poll.name).toBe('Favorite color?');
  });

  it('returns null for empty input', () => {
    expect(parsePoll('')).toBeNull();
    expect(parsePoll('   ')).toBeNull();
  });

  it('returns null for too few options (need question + 2 opts)', () => {
    expect(parsePoll('Question / OnlyOneOption')).toBeNull();
  });

  it('returns null for plain text without separators', () => {
    expect(parsePoll('just a plain question with no options')).toBeNull();
  });

  it('caps options at 12 (WhatsApp limit)', () => {
    const parts = ['Question?'];
    for (let i = 1; i <= 15; i++) parts.push(`Option ${i}`);
    const poll = must(parsePoll(parts.join(' / ')), 'expected poll');
    expect(poll.values).toHaveLength(12);
  });

  it('trims whitespace from question and options', () => {
    const poll = must(parsePoll('  Question?  /  A  /  B  /  C  '), 'expected poll');
    expect(poll.name).toBe('Question?');
    expect(poll.values).toEqual(['A', 'B', 'C']);
  });
});

describe('Polls — handlePoll', async () => {
  const { handlePoll } = await import('../src/features/polls.js');

  it('returns help for empty input', () => {
    const result = handlePoll('');
    expect(typeof result).toBe('string');
    expect(result as string).toContain('Create a Poll');
  });

  it('returns PollData for valid slash format', () => {
    const result = handlePoll('What day? / Friday / Saturday');
    expect(typeof result).not.toBe('string');
    const poll = result as { name: string; values: string[]; selectableCount: number };
    expect(poll.name).toBe('What day?');
    expect(poll.values).toEqual(['Friday', 'Saturday']);
    expect(poll.selectableCount).toBe(1);
  });

  it('supports multi-select flag', () => {
    const result = handlePoll('multi Pick activities / Bowling / Trivia / Karaoke');
    expect(typeof result).not.toBe('string');
    const poll = result as { name: string; values: string[]; selectableCount: number };
    expect(poll.selectableCount).toBe(0); // 0 = unlimited in WhatsApp
    expect(poll.values).toHaveLength(3);
  });

  it('returns error string for unparseable input', () => {
    const result = handlePoll('just some text with no structure');
    expect(typeof result).toBe('string');
    expect(result as string).toContain("Couldn't parse");
  });
});

describe('Polls — deduplication', async () => {
  const { isDuplicatePoll, recordPoll } = await import('../src/features/polls.js');

  const testGroup = 'test-group-dedup@g.us';

  it('does not flag first poll as duplicate', () => {
    expect(isDuplicatePoll(testGroup, 'Unique question for dedup test?')).toBe(false);
  });

  it('flags exact same question as duplicate after recording', () => {
    const question = 'Is this a duplicate test?';
    recordPoll(testGroup, question);
    expect(isDuplicatePoll(testGroup, question)).toBe(true);
  });

  it('flags case-insensitive duplicate', () => {
    const question = 'Case Test Question For Dedup?';
    recordPoll(testGroup, question);
    expect(isDuplicatePoll(testGroup, question.toLowerCase())).toBe(true);
  });

  it('flags substring match (minor rewording)', () => {
    const question = 'What should we do this weekend?';
    recordPoll(testGroup, question);
    // Shorter version that is contained in the normalized original
    expect(isDuplicatePoll(testGroup, 'what should we do this weekend')).toBe(true);
  });

  it('does not flag different questions as duplicates', () => {
    recordPoll(testGroup, 'Completely unrelated alpha query?');
    expect(isDuplicatePoll(testGroup, 'Something totally different beta?')).toBe(false);
  });

  it('does not flag polls in different groups', () => {
    const otherGroup = 'other-group-dedup@g.us';
    recordPoll(testGroup, 'Group-specific question zeta?');
    expect(isDuplicatePoll(otherGroup, 'Group-specific question zeta?')).toBe(false);
  });
});

// ── 3c. Fun features ────────────────────────────────────────────

describe('Fun — decodeHTML', async () => {
  const { decodeHTML } = await import('../src/features/fun.js');

  it('decodes common HTML entities', () => {
    expect(decodeHTML('&amp;')).toBe('&');
    expect(decodeHTML('&lt;')).toBe('<');
    expect(decodeHTML('&gt;')).toBe('>');
    expect(decodeHTML('&quot;')).toBe('"');
    expect(decodeHTML('&#039;')).toBe("'");
  });

  it('decodes accented characters', () => {
    expect(decodeHTML('caf&eacute;')).toBe('caf\u00e9');
    expect(decodeHTML('&eacute;')).toBe('\u00e9');
    expect(decodeHTML('&ntilde;')).toBe('ñ');
  });

  it('decodes mixed text', () => {
    expect(decodeHTML('Tom &amp; Jerry&#039;s &quot;Adventure&quot;')).toBe('Tom & Jerry\'s "Adventure"');
  });

  it('passes through text without entities', () => {
    expect(decodeHTML('just normal text')).toBe('just normal text');
  });
});

describe('Fun — TRIVIA_CATEGORIES', async () => {
  const { TRIVIA_CATEGORIES } = await import('../src/features/fun.js');

  it('maps category names to OpenTDB IDs', () => {
    expect(TRIVIA_CATEGORIES['general']).toBe(9);
    expect(TRIVIA_CATEGORIES['science']).toBe(17);
    expect(TRIVIA_CATEGORIES['history']).toBe(23);
    expect(TRIVIA_CATEGORIES['sports']).toBe(21);
  });

  it('has aliases for some categories', () => {
    expect(TRIVIA_CATEGORIES['film']).toBe(TRIVIA_CATEGORIES['movies']);
    expect(TRIVIA_CATEGORIES['tv']).toBe(TRIVIA_CATEGORIES['television']);
    expect(TRIVIA_CATEGORIES['computers']).toBe(TRIVIA_CATEGORIES['tech']);
    expect(TRIVIA_CATEGORIES['books']).toBe(TRIVIA_CATEGORIES['literature']);
    expect(TRIVIA_CATEGORIES['games']).toBe(TRIVIA_CATEGORIES['videogames']);
  });
});

describe('Fun — ICEBREAKERS', async () => {
  const { ICEBREAKERS } = await import('../src/features/fun.js');

  it('has 40 icebreaker questions', () => {
    expect(ICEBREAKERS).toHaveLength(40);
  });

  it('all icebreakers end with ?', () => {
    for (const q of ICEBREAKERS) {
      expect(q.endsWith('?')).toBe(true);
    }
  });

  it('contains Boston-themed questions', () => {
    const bostonQuestions = ICEBREAKERS.filter((q) =>
      /boston|T\b|dunkin|fenway|north end|newbury|somerville/i.test(q),
    );
    expect(bostonQuestions.length).toBeGreaterThan(5);
  });
});

describe('Fun — handleFun routing', async () => {
  const { handleFun } = await import('../src/features/fun.js');

  it('returns help for empty input', async () => {
    const result = await handleFun('');
    expect(result).toContain('Fun Commands');
    expect(result).toContain('!trivia');
    expect(result).toContain('!fact');
    expect(result).toContain('!today');
    expect(result).toContain('!icebreaker');
  });

  it('returns help for "help" input', async () => {
    const result = await handleFun('help');
    expect(result).toContain('Fun Commands');
  });

  it('returns an icebreaker for "icebreaker"', async () => {
    const result = await handleFun('icebreaker');
    expect(result).toContain('Icebreaker');
    expect(result).toContain('?'); // All icebreakers are questions
  });

  it('returns an icebreaker for "ice" shorthand', async () => {
    const result = await handleFun('ice');
    expect(result).toContain('Icebreaker');
  });

  it('routes category name directly as trivia', async () => {
    // "science" should be recognized as a trivia category
    // This makes a network call to OpenTDB, so it may fail in CI
    // But the routing logic should at least not return help
    const result = await handleFun('science');
    // Should either return trivia or an error from the API — NOT help
    expect(result).not.toContain('Fun Commands');
  });

  it('returns help for unrecognized subcommands', async () => {
    const result = await handleFun('nonsense gibberish');
    expect(result).toContain('Fun Commands');
  });
});
