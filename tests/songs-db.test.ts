import { describe, expect, it, vi } from 'vitest';

/**
 * Band memory — songs table CRUD (sqlite backend, real db via the shared
 * `src/utils/db.js` barrel, following the integration pattern in
 * tests/phase6.test.ts / tests/db-shared-layer.test.ts).
 */

describe('Songs — shared band memory', async () => {
  const { addSong, getSongById, getSongByTitle, listSongs, updateSong, deleteSong } =
    await import('../src/utils/db.js');

  it('adds a song with default status "idea" when not provided', async () => {
    const song = await addSong({ title: 'Sweet Garbanzo Sunrise' });

    expect(song.id).toBeGreaterThan(0);
    expect(song.title).toBe('Sweet Garbanzo Sunrise');
    expect(song.key).toBeNull();
    expect(song.tempo).toBeNull();
    expect(song.status).toBe('idea');
    expect(song.notes).toBeNull();
    expect(song.createdAt).toBeGreaterThan(0);
    expect(song.updatedAt).toBeGreaterThan(0);
  });

  it('adds a song with all fields provided', async () => {
    const song = await addSong({
      title: 'Chickpea Boogie',
      key: 'G',
      tempo: 120,
      status: 'rough',
      notes: 'needs a bridge',
    });

    expect(song.title).toBe('Chickpea Boogie');
    expect(song.key).toBe('G');
    expect(song.tempo).toBe(120);
    expect(song.status).toBe('rough');
    expect(song.notes).toBe('needs a bridge');
  });

  it('gets a song by id', async () => {
    const created = await addSong({ title: 'Falafel Fever' });
    const fetched = await getSongById(created.id);

    expect(fetched).toEqual(created);
  });

  it('returns undefined for a missing song id', async () => {
    expect(await getSongById(999_999)).toBeUndefined();
  });

  it('gets a song by title, case-insensitively', async () => {
    const created = await addSong({ title: 'Hummus and Highways' });

    expect(await getSongByTitle('hummus and highways')).toEqual(created);
    expect(await getSongByTitle('HUMMUS AND HIGHWAYS')).toEqual(created);
    expect(await getSongByTitle('Hummus And Highways')).toEqual(created);
  });

  it('returns undefined for a missing title', async () => {
    expect(await getSongByTitle('no such song, sorry')).toBeUndefined();
  });

  it('lists all songs and filters by status', async () => {
    const before = await listSongs();
    const beforeCount = before.length;

    const idea = await addSong({ title: `List Song Idea ${Date.now()}` });
    const gigReady = await addSong({ title: `List Song Gig Ready ${Date.now()}`, status: 'gig-ready' });

    const all = await listSongs();
    expect(all.length).toBe(beforeCount + 2);
    expect(all.map((song) => song.id)).toEqual(expect.arrayContaining([idea.id, gigReady.id]));

    const gigReadyOnly = await listSongs('gig-ready');
    expect(gigReadyOnly.map((song) => song.id)).toContain(gigReady.id);
    expect(gigReadyOnly.every((song) => song.status === 'gig-ready')).toBe(true);
    expect(gigReadyOnly.map((song) => song.id)).not.toContain(idea.id);
  });

  it('updates only the provided fields and bumps updatedAt', async () => {
    // updatedAt is stored in unix seconds, so a same-second create+update pair
    // would pass a `>= createdAt` check even if the bump logic were removed
    // entirely. Freeze the clock, capture the pre-update timestamp, then jump
    // forward a full second before updating so a missing bump is caught.
    vi.useFakeTimers();
    try {
      const created = await addSong({ title: 'Patchwork Melody', key: 'C', tempo: 100, notes: 'draft' });
      const preUpdateUpdatedAt = created.updatedAt;

      vi.advanceTimersByTime(1_500);

      const updated = await updateSong(created.id, { tempo: 140, status: 'tight' });

      expect(updated).toBeDefined();
      expect(updated?.title).toBe('Patchwork Melody');
      expect(updated?.key).toBe('C');
      expect(updated?.tempo).toBe(140);
      expect(updated?.status).toBe('tight');
      expect(updated?.notes).toBe('draft');
      expect(updated?.createdAt).toBe(created.createdAt);
      expect(updated?.updatedAt).toBeGreaterThan(preUpdateUpdatedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns undefined when updating a missing song', async () => {
    expect(await updateSong(999_999, { tempo: 90 })).toBeUndefined();
  });

  it('deletes a song, then getSongById returns undefined', async () => {
    const created = await addSong({ title: 'Ephemeral Encore' });

    expect(await deleteSong(created.id)).toBe(true);
    expect(await getSongById(created.id)).toBeUndefined();
  });

  it('returns false when deleting a missing song', async () => {
    expect(await deleteSong(999_999)).toBe(false);
  });
});
