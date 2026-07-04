import { describe, expect, it } from 'vitest';

/**
 * Band memory — song_ideas table CRUD (sqlite backend, real db via the shared
 * `src/utils/db.js` barrel, following the integration pattern in
 * tests/songs-db.test.ts).
 */

describe('Song ideas — shared band memory', async () => {
  const { addSong, addSongIdea, getSongIdeaById, listSongIdeas, linkSongIdeaToSong, deleteSongIdea } =
    await import('../src/utils/db.js');

  it('adds a text-only song idea', async () => {
    const idea = await addSongIdea({ text: 'verse about chickpeas and highways' });

    expect(idea.id).toBeGreaterThan(0);
    expect(idea.title).toBeNull();
    expect(idea.text).toBe('verse about chickpeas and highways');
    expect(idea.audioUrl).toBeNull();
    expect(idea.transcript).toBeNull();
    expect(idea.songId).toBeNull();
    expect(idea.createdBy).toBeNull();
    expect(idea.createdAt).toBeGreaterThan(0);
  });

  it('adds a song idea with audioUrl, transcript, and songId', async () => {
    const song = await addSong({ title: `Idea Source Song ${Date.now()}` });

    const idea = await addSongIdea({
      title: 'Bridge idea',
      audioUrl: 'https://example.com/voice-memo.m4a',
      transcript: 'hummed melody, needs lyrics',
      songId: song.id,
      createdBy: 'owner-jid',
    });

    expect(idea.title).toBe('Bridge idea');
    expect(idea.audioUrl).toBe('https://example.com/voice-memo.m4a');
    expect(idea.transcript).toBe('hummed melody, needs lyrics');
    expect(idea.songId).toBe(song.id);
    expect(idea.createdBy).toBe('owner-jid');
  });

  it('gets a song idea by id', async () => {
    const created = await addSongIdea({ text: 'chorus hook idea' });
    const fetched = await getSongIdeaById(created.id);

    expect(fetched).toEqual(created);
  });

  it('returns undefined for a missing song idea id', async () => {
    expect(await getSongIdeaById(999_999)).toBeUndefined();
  });

  it('lists song ideas newest-first and respects limit', async () => {
    const first = await addSongIdea({ text: `Ordering idea 1 ${Date.now()}` });
    const second = await addSongIdea({ text: `Ordering idea 2 ${Date.now()}` });
    const third = await addSongIdea({ text: `Ordering idea 3 ${Date.now()}` });

    const all = await listSongIdeas();
    const ids = all.map((idea) => idea.id);
    expect(ids.indexOf(third.id)).toBeLessThan(ids.indexOf(second.id));
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));

    const limited = await listSongIdeas(2);
    expect(limited.length).toBe(2);
    expect(limited[0].id).toBe(third.id);
    expect(limited[1].id).toBe(second.id);
  });

  it('links a song idea to a song, setting song_id', async () => {
    const idea = await addSongIdea({ text: 'unlinked idea' });
    const song = await addSong({ title: `Link Target Song ${Date.now()}` });

    expect(idea.songId).toBeNull();

    const linked = await linkSongIdeaToSong(idea.id, song.id);
    expect(linked).toBe(true);

    const fetched = await getSongIdeaById(idea.id);
    expect(fetched?.songId).toBe(song.id);
  });

  it('returns false when linking a missing song idea', async () => {
    const song = await addSong({ title: `Link Missing Song ${Date.now()}` });
    expect(await linkSongIdeaToSong(999_999, song.id)).toBe(false);
  });

  it('deletes a song idea, then getSongIdeaById returns undefined', async () => {
    const created = await addSongIdea({ text: 'temporary idea' });

    expect(await deleteSongIdea(created.id)).toBe(true);
    expect(await getSongIdeaById(created.id)).toBeUndefined();
  });

  it('returns false when deleting a missing song idea', async () => {
    expect(await deleteSongIdea(999_999)).toBe(false);
  });
});
