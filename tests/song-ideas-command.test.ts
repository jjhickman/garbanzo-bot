process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongIdea } from '../src/utils/db-types.js';

const dbMocks = vi.hoisted(() => ({
  addSong: vi.fn(),
  addSongIdea: vi.fn(),
  getSongIdeaById: vi.fn(),
  listSongIdeas: vi.fn(),
  linkSongIdeaToSong: vi.fn(),
  deleteSongIdea: vi.fn(),
}));

vi.mock('../src/utils/db.js', () => dbMocks);

const voiceMocks = vi.hoisted(() => ({
  transcribeAudio: vi.fn(),
}));

vi.mock('../src/features/voice.js', () => voiceMocks);

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { fetchAndTranscribe, formatIdeaLine, handleIdeaCommand } from '../src/features/song-ideas.js';

function makeIdea(overrides: Partial<SongIdea> = {}): SongIdea {
  return {
    id: 3,
    title: null,
    text: null,
    audioUrl: null,
    transcript: null,
    songId: null,
    createdBy: null,
    createdAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  dbMocks.addSong.mockReset();
  dbMocks.addSongIdea.mockReset();
  dbMocks.getSongIdeaById.mockReset();
  dbMocks.listSongIdeas.mockReset();
  dbMocks.linkSongIdeaToSong.mockReset();
  dbMocks.deleteSongIdea.mockReset();
  voiceMocks.transcribeAudio.mockReset();
  fetchMock.mockReset();
});

describe('formatIdeaLine', () => {
  it('renders id, title, and text snippet', () => {
    const line = formatIdeaLine(makeIdea({ id: 3, title: 'Ocean riff', text: 'verse about waves' }));
    expect(line).toContain('#3');
    expect(line).toContain('Ocean riff');
    expect(line).toContain('verse about waves');
  });

  it('falls back to the transcript when text is null', () => {
    const line = formatIdeaLine(makeIdea({ id: 4, title: null, text: null, transcript: 'hummed melody' }));
    expect(line).toContain('#4');
    expect(line).toContain('hummed melody');
  });

  it('handles an idea with no title, text, or transcript', () => {
    const line = formatIdeaLine(makeIdea({ id: 5 }));
    expect(line).toContain('#5');
  });
});

describe('fetchAndTranscribe', () => {
  it('fetches the url, buffers the body, and transcribes it', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
    voiceMocks.transcribeAudio.mockResolvedValueOnce('transcribed text');

    const result = await fetchAndTranscribe('https://example.com/a.ogg', 'audio/ogg');

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/a.ogg', expect.any(Object));
    expect(voiceMocks.transcribeAudio).toHaveBeenCalledWith(expect.any(Buffer), 'audio/ogg');
    expect(result).toBe('transcribed text');
  });

  it('returns null when the response is not ok', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await fetchAndTranscribe('https://example.com/missing.ogg', 'audio/ogg');

    expect(result).toBeNull();
    expect(voiceMocks.transcribeAudio).not.toHaveBeenCalled();
  });

  it('returns null when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    const result = await fetchAndTranscribe('https://example.com/a.ogg', 'audio/ogg');

    expect(result).toBeNull();
  });

  it('returns null when transcribeAudio returns null', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
    voiceMocks.transcribeAudio.mockResolvedValueOnce(null);

    const result = await fetchAndTranscribe('https://example.com/a.ogg', 'audio/ogg');

    expect(result).toBeNull();
  });
});

describe('handleIdeaCommand', () => {
  describe('capture (text only)', () => {
    it('stores a text-only idea when no audio is attached', async () => {
      dbMocks.addSongIdea.mockResolvedValueOnce(makeIdea({ text: 'verse about chickpeas' }));

      const result = await handleIdeaCommand('capture verse about chickpeas', { senderId: '222' });

      expect(dbMocks.addSongIdea).toHaveBeenCalledWith({
        title: undefined,
        text: 'verse about chickpeas',
        audioUrl: undefined,
        transcript: undefined,
        createdBy: '222',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(voiceMocks.transcribeAudio).not.toHaveBeenCalled();
      expect(result).toMatch(/captured/i);
      expect(result).toContain('verse about chickpeas');
    });

    it('accepts an explicit title plus a text= field', async () => {
      dbMocks.addSongIdea.mockResolvedValueOnce(makeIdea({ title: 'Ocean riff', text: 'waves crashing' }));

      const result = await handleIdeaCommand('capture Ocean riff text=waves crashing', { senderId: '222' });

      expect(dbMocks.addSongIdea).toHaveBeenCalledWith({
        title: 'Ocean riff',
        text: 'waves crashing',
        audioUrl: undefined,
        transcript: undefined,
        createdBy: '222',
      });
      expect(result).toContain('Ocean riff');
    });

    it('returns friendly usage when there is no text, title, or audio', async () => {
      const result = await handleIdeaCommand('capture', { senderId: '222' });

      expect(dbMocks.addSongIdea).not.toHaveBeenCalled();
      expect(result).toMatch(/usage/i);
    });
  });

  describe('capture (with audio)', () => {
    it('fetches and transcribes the clip, storing transcript + audioUrl', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
      voiceMocks.transcribeAudio.mockResolvedValueOnce('hummed melody about the ocean');
      dbMocks.addSongIdea.mockResolvedValueOnce(makeIdea({
        title: 'Bridge idea',
        audioUrl: 'https://cdn.example.com/clip.ogg',
        transcript: 'hummed melody about the ocean',
      }));

      const result = await handleIdeaCommand('capture Bridge idea', {
        senderId: '222',
        audio: { url: 'https://cdn.example.com/clip.ogg', contentType: 'audio/ogg' },
      });

      expect(fetchMock).toHaveBeenCalledWith('https://cdn.example.com/clip.ogg', expect.any(Object));
      expect(voiceMocks.transcribeAudio).toHaveBeenCalledWith(expect.any(Buffer), 'audio/ogg');
      expect(dbMocks.addSongIdea).toHaveBeenCalledWith({
        title: 'Bridge idea',
        text: undefined,
        audioUrl: 'https://cdn.example.com/clip.ogg',
        transcript: 'hummed melody about the ocean',
        createdBy: '222',
      });
      expect(result).toMatch(/captured/i);
    });

    it('still stores the idea when transcription returns null, and notes it in the reply', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
      voiceMocks.transcribeAudio.mockResolvedValueOnce(null);
      dbMocks.addSongIdea.mockResolvedValueOnce(makeIdea({
        audioUrl: 'https://cdn.example.com/clip.ogg',
        transcript: null,
      }));

      const result = await handleIdeaCommand('capture', {
        senderId: '222',
        audio: { url: 'https://cdn.example.com/clip.ogg', contentType: 'audio/ogg' },
      });

      expect(dbMocks.addSongIdea).toHaveBeenCalledWith({
        title: undefined,
        text: undefined,
        audioUrl: 'https://cdn.example.com/clip.ogg',
        transcript: null,
        createdBy: '222',
      });
      expect(result).toMatch(/transcription.*(unavailable|failed)/i);
    });

    it('gracefully stores the idea (transcript null) when the audio fetch throws', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      dbMocks.addSongIdea.mockResolvedValueOnce(makeIdea({
        audioUrl: 'https://cdn.example.com/clip.ogg',
        transcript: null,
      }));

      const result = await handleIdeaCommand('capture', {
        senderId: '222',
        audio: { url: 'https://cdn.example.com/clip.ogg', contentType: 'audio/ogg' },
      });

      expect(voiceMocks.transcribeAudio).not.toHaveBeenCalled();
      expect(dbMocks.addSongIdea).toHaveBeenCalledWith({
        title: undefined,
        text: undefined,
        audioUrl: 'https://cdn.example.com/clip.ogg',
        transcript: null,
        createdBy: '222',
      });
      expect(result).toMatch(/transcription.*(unavailable|failed)/i);
    });
  });

  describe('list', () => {
    it('renders recent ideas', async () => {
      dbMocks.listSongIdeas.mockResolvedValueOnce([
        makeIdea({ id: 3, title: 'Ocean riff', text: 'waves' }),
        makeIdea({ id: 4, text: null, transcript: 'hummed thing' }),
      ]);

      const result = await handleIdeaCommand('list', { senderId: '222' });

      expect(dbMocks.listSongIdeas).toHaveBeenCalledWith(expect.any(Number));
      expect(result).toContain('#3');
      expect(result).toContain('Ocean riff');
      expect(result).toContain('#4');
    });

    it('shows a friendly empty message', async () => {
      dbMocks.listSongIdeas.mockResolvedValueOnce([]);

      const result = await handleIdeaCommand('list', { senderId: '222' });

      expect(result).toMatch(/no .*ideas/i);
    });
  });

  describe('show', () => {
    it('renders idea details', async () => {
      dbMocks.getSongIdeaById.mockResolvedValueOnce(makeIdea({
        id: 3,
        title: 'Ocean riff',
        text: 'waves crashing',
        transcript: 'hummed melody',
        audioUrl: 'https://cdn.example.com/a.ogg',
        songId: 9,
      }));

      const result = await handleIdeaCommand('show 3', { senderId: '222' });

      expect(dbMocks.getSongIdeaById).toHaveBeenCalledWith(3);
      expect(result).toContain('#3');
      expect(result).toContain('Ocean riff');
      expect(result).toContain('waves crashing');
      expect(result).toContain('hummed melody');
      expect(result).toContain('https://cdn.example.com/a.ogg');
      expect(result).toContain('9');
    });

    it('returns a not-found message', async () => {
      dbMocks.getSongIdeaById.mockResolvedValueOnce(undefined);

      const result = await handleIdeaCommand('show 999', { senderId: '222' });

      expect(result).toMatch(/not found|no .*idea/i);
    });
  });

  describe('promote', () => {
    it('creates a song with status idea and links it back', async () => {
      dbMocks.getSongIdeaById.mockResolvedValueOnce(makeIdea({ id: 3, title: 'Ocean riff' }));
      dbMocks.addSong.mockResolvedValueOnce({
        id: 9, title: 'Ocean riff', key: null, tempo: null, status: 'idea', notes: null, createdAt: 0, updatedAt: 0,
      });
      dbMocks.linkSongIdeaToSong.mockResolvedValueOnce(true);

      const result = await handleIdeaCommand('promote 3', { senderId: '222' });

      expect(dbMocks.getSongIdeaById).toHaveBeenCalledWith(3);
      expect(dbMocks.addSong).toHaveBeenCalledWith({ title: 'Ocean riff', status: 'idea' });
      expect(dbMocks.linkSongIdeaToSong).toHaveBeenCalledWith(3, 9);
      expect(result).toContain('Ocean riff');
    });

    it('uses a title override when provided', async () => {
      dbMocks.getSongIdeaById.mockResolvedValueOnce(makeIdea({ id: 3, title: null, text: 'some idea' }));
      dbMocks.addSong.mockResolvedValueOnce({
        id: 10, title: 'New Title', key: null, tempo: null, status: 'idea', notes: null, createdAt: 0, updatedAt: 0,
      });
      dbMocks.linkSongIdeaToSong.mockResolvedValueOnce(true);

      const result = await handleIdeaCommand('promote 3 New Title', { senderId: '222' });

      expect(dbMocks.addSong).toHaveBeenCalledWith({ title: 'New Title', status: 'idea' });
      expect(result).toContain('New Title');
    });

    it('falls back to "Untitled" when the idea has no title and no override is given', async () => {
      dbMocks.getSongIdeaById.mockResolvedValueOnce(makeIdea({ id: 3, title: null, text: 'some idea' }));
      dbMocks.addSong.mockResolvedValueOnce({
        id: 11, title: 'Untitled', key: null, tempo: null, status: 'idea', notes: null, createdAt: 0, updatedAt: 0,
      });
      dbMocks.linkSongIdeaToSong.mockResolvedValueOnce(true);

      await handleIdeaCommand('promote 3', { senderId: '222' });

      expect(dbMocks.addSong).toHaveBeenCalledWith({ title: 'Untitled', status: 'idea' });
    });

    it('returns a not-found message for a missing idea', async () => {
      dbMocks.getSongIdeaById.mockResolvedValueOnce(undefined);

      const result = await handleIdeaCommand('promote 999', { senderId: '222' });

      expect(dbMocks.addSong).not.toHaveBeenCalled();
      expect(result).toMatch(/not found|no .*idea/i);
    });
  });

  describe('delete', () => {
    it('deletes an existing idea', async () => {
      dbMocks.deleteSongIdea.mockResolvedValueOnce(true);

      const result = await handleIdeaCommand('delete 3', { senderId: '222' });

      expect(dbMocks.deleteSongIdea).toHaveBeenCalledWith(3);
      expect(result).toMatch(/deleted/i);
    });

    it('returns a not-found message', async () => {
      dbMocks.deleteSongIdea.mockResolvedValueOnce(false);

      const result = await handleIdeaCommand('delete 999', { senderId: '222' });

      expect(result).toMatch(/not found|no .*idea/i);
    });
  });

  describe('unknown/empty subcommand', () => {
    it('returns usage for an unknown subcommand', async () => {
      const result = await handleIdeaCommand('frobnicate 3', { senderId: '222' });

      expect(result).toMatch(/usage|commands/i);
      expect(result).toMatch(/capture/);
      expect(result).toMatch(/list/);
      expect(result).toMatch(/show/);
      expect(result).toMatch(/promote/);
      expect(result).toMatch(/delete/);
    });

    it('returns usage for empty args', async () => {
      const result = await handleIdeaCommand('', { senderId: '222' });

      expect(result).toMatch(/usage|commands/i);
    });
  });
});
