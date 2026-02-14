import { describe, it, expect } from 'vitest';

/**
 * Tests for multimedia features: voice, media understanding, link processing.
 *
 * These test the pure logic functions — actual media download, Whisper API,
 * Piper TTS, and Claude Vision are integration tests that need real services.
 */

// ── Voice — voice selection and command parsing ─────────────────────

describe('Voice — command parsing', async () => {
  const { handleVoiceCommand, formatVoiceList } = await import('../src/features/voice.js');

  it('returns list action for empty args', () => {
    expect(handleVoiceCommand('').action).toBe('list');
  });

  it('returns list action for "list"', () => {
    expect(handleVoiceCommand('list').action).toBe('list');
  });

  it('returns list action for "voices"', () => {
    expect(handleVoiceCommand('voices').action).toBe('list');
  });

  it('returns list action for "help"', () => {
    expect(handleVoiceCommand('help').action).toBe('list');
  });

  it('returns speak action with voice ID', () => {
    const result = handleVoiceCommand('british');
    expect(result.action).toBe('speak');
    expect(result.voiceId).toBe('british');
  });

  it('returns speak action for spanish', () => {
    const result = handleVoiceCommand('spanish');
    expect(result.action).toBe('speak');
    expect(result.voiceId).toBe('spanish');
  });

  it('formats voice list with all voices', () => {
    const list = formatVoiceList();
    expect(list).toContain('Available Voices');
    expect(list).toContain('default');
    expect(list).toContain('british');
    expect(list).toContain('spanish');
    expect(list).toContain('french');
    expect(list).toContain('german');
    expect(list).toContain('portuguese');
    expect(list).toContain('!voice');
  });
});

// ── Links — URL extraction and classification ───────────────────────

describe('Links — URL extraction', async () => {
  const { extractUrls, isYouTubeUrl, extractYouTubeId } = await import('../src/features/links.js');

  it('extracts URLs from text', () => {
    const urls = extractUrls('Check out https://example.com and https://foo.bar/baz');
    expect(urls).toHaveLength(2);
    expect(urls).toContain('https://example.com');
    expect(urls).toContain('https://foo.bar/baz');
  });

  it('returns empty array for text without URLs', () => {
    expect(extractUrls('No links here')).toHaveLength(0);
  });

  it('deduplicates URLs', () => {
    const urls = extractUrls('https://example.com and https://example.com again');
    expect(urls).toHaveLength(1);
  });

  it('detects YouTube watch URLs', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isYouTubeUrl('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
  });

  it('detects YouTube short URLs', () => {
    expect(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
  });

  it('detects YouTube shorts URLs', () => {
    expect(isYouTubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(true);
  });

  it('rejects non-YouTube URLs', () => {
    expect(isYouTubeUrl('https://example.com')).toBe(false);
    expect(isYouTubeUrl('https://vimeo.com/123')).toBe(false);
  });

  it('extracts YouTube video ID', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('returns null for non-YouTube URLs', () => {
    expect(extractYouTubeId('https://example.com')).toBeNull();
  });
});

// ── Router — new bang commands ──────────────────────────────────────

describe('Router — voice bang commands', async () => {
  const { matchFeature } = await import('../src/features/router.js');

  it('routes !voice', () => {
    expect(matchFeature('!voice')?.feature).toBe('voice');
  });

  it('routes !voice list', () => {
    const match = matchFeature('!voice list');
    expect(match?.feature).toBe('voice');
    expect(match?.query).toBe('list');
  });

  it('routes !voice british', () => {
    const match = matchFeature('!voice british');
    expect(match?.feature).toBe('voice');
    expect(match?.query).toBe('british');
  });

  it('routes !speak', () => {
    expect(matchFeature('!speak')?.feature).toBe('voice');
  });

  it('routes !tts', () => {
    expect(matchFeature('!tts')?.feature).toBe('voice');
  });
});

// ── Media — vision preparation helpers ──────────────────────────────

describe('Media — helper functions', async () => {
  // We can't easily test extractMedia/downloadMediaMessage without a real
  // Baileys socket, but we can test the helper logic.
  const { hasVisualMedia, isVoiceMessage } = await import('../src/features/media.js');

  it('hasVisualMedia returns false for null message', () => {
    // @ts-expect-error — testing with invalid input
    expect(hasVisualMedia({ message: null })).toBe(false);
  });

  it('isVoiceMessage returns false for null message', () => {
    // @ts-expect-error — testing with invalid input
    expect(isVoiceMessage({ message: null })).toBe(false);
  });

  it('isVoiceMessage returns false for text message', () => {
    expect(isVoiceMessage({
      key: { id: '1', remoteJid: 'test@g.us' },
      message: { conversation: 'hello' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)).toBe(false);
  });
});

// ── AI Router — vision content building ─────────────────────────────

describe('AI Router — vision support', async () => {
  // Test that the router module exports updated getAIResponse with vision param
  const { getAIResponse, classifyComplexity } = await import('../src/ai/router.js');

  it('getAIResponse accepts optional vision parameter', () => {
    // Just verify the function accepts 3 params without TypeScript error
    expect(getAIResponse).toBeTypeOf('function');
    expect(getAIResponse.length).toBeGreaterThanOrEqual(2);
  });

  it('classifies media-related queries as complex (quoted context)', () => {
    // Messages with media have quoted context, which routes to complex → Claude
    const result = classifyComplexity('what is this?', {
      groupName: 'General',
      groupJid: 'test@g.us',
      senderJid: 'user@s.whatsapp.net',
      quotedText: 'some quoted message',
    });
    expect(result).toBe('complex');
  });
});

// ── Help — updated with multimedia ──────────────────────────────────

describe('Help — multimedia commands', async () => {
  const { getHelpMessage } = await import('../src/features/help.js');

  it('includes voice commands', () => {
    const help = getHelpMessage();
    expect(help).toContain('!voice');
    expect(help).toContain('voice note');
    expect(help).toContain('YouTube');
  });

  it('includes media description', () => {
    const help = getHelpMessage();
    expect(help).toContain('image');
    expect(help).toContain('multimedia');
  });
});
