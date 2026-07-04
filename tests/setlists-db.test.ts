process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { describe, expect, it } from 'vitest';

/**
 * Band practice — setlists + setlist_songs tables (sqlite backend, real db via
 * the shared `src/utils/db.js` barrel, mirroring tests/rehearsals-db.test.ts).
 */

describe('Setlists — ordered song lists referencing shared band songs', async () => {
  const {
    addSong,
    deleteSong,
    addSetlist,
    getSetlistByName,
    listSetlists,
    deleteSetlist,
    addSongToSetlist,
    removeSongFromSetlist,
    moveSetlistSong,
    getSetlistSongs,
  } = await import('../src/utils/db.js');

  it('adds a setlist and gets it back by name, case-insensitively', async () => {
    const setlist = await addSetlist({ name: `Summer Gig ${Date.now()}`, notes: 'outdoor set' });

    expect(setlist.id).toBeGreaterThan(0);
    expect(setlist.notes).toBe('outdoor set');
    expect(setlist.createdAt).toBeGreaterThan(0);
    expect(setlist.updatedAt).toBeGreaterThan(0);

    expect(await getSetlistByName(setlist.name.toUpperCase())).toEqual(setlist);
    expect(await getSetlistByName(setlist.name.toLowerCase())).toEqual(setlist);
  });

  it('defaults notes to null when not provided', async () => {
    const setlist = await addSetlist({ name: `No Notes ${Date.now()}` });
    expect(setlist.notes).toBeNull();
  });

  it('returns undefined for a missing setlist name', async () => {
    expect(await getSetlistByName('no such setlist, sorry')).toBeUndefined();
  });

  it('lists all setlists', async () => {
    const before = await listSetlists();
    const beforeCount = before.length;

    const a = await addSetlist({ name: `List Setlist A ${Date.now()}` });
    const b = await addSetlist({ name: `List Setlist B ${Date.now()}` });

    const all = await listSetlists();
    expect(all.length).toBe(beforeCount + 2);
    expect(all.map((setlist) => setlist.id)).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('appends songs to a setlist with contiguous positions when no position is given', async () => {
    const setlist = await addSetlist({ name: `Append Positions ${Date.now()}` });
    const songOne = await addSong({ title: `Append Song One ${Date.now()}` });
    const songTwo = await addSong({ title: `Append Song Two ${Date.now()}` });
    const songThree = await addSong({ title: `Append Song Three ${Date.now()}` });

    const entryOne = await addSongToSetlist(setlist.id, songOne.id);
    const entryTwo = await addSongToSetlist(setlist.id, songTwo.id);
    const entryThree = await addSongToSetlist(setlist.id, songThree.id);

    expect(entryOne.position).toBe(1);
    expect(entryTwo.position).toBe(2);
    expect(entryThree.position).toBe(3);
    expect(entryOne.setlistId).toBe(setlist.id);
    expect(entryOne.songId).toBe(songOne.id);
  });

  it('adds a song at an explicit position when given', async () => {
    const setlist = await addSetlist({ name: `Explicit Position ${Date.now()}` });
    const song = await addSong({ title: `Explicit Position Song ${Date.now()}` });

    const entry = await addSongToSetlist(setlist.id, song.id, 5);
    expect(entry.position).toBe(5);
  });

  it('returns joined Song data ordered by position via getSetlistSongs', async () => {
    const setlist = await addSetlist({ name: `Joined Songs ${Date.now()}` });
    const songA = await addSong({ title: `Joined Song A ${Date.now()}`, key: 'G', tempo: 100 });
    const songB = await addSong({ title: `Joined Song B ${Date.now()}`, key: 'D', tempo: 120 });

    await addSongToSetlist(setlist.id, songA.id);
    await addSongToSetlist(setlist.id, songB.id);

    const entries = await getSetlistSongs(setlist.id);

    expect(entries).toHaveLength(2);
    expect(entries[0].position).toBe(1);
    expect(entries[0].song).toEqual(songA);
    expect(entries[1].position).toBe(2);
    expect(entries[1].song).toEqual(songB);
  });

  it('reorders songs with moveSetlistSong', async () => {
    const setlist = await addSetlist({ name: `Move Songs ${Date.now()}` });
    const songA = await addSong({ title: `Move Song A ${Date.now()}` });
    const songB = await addSong({ title: `Move Song B ${Date.now()}` });
    const songC = await addSong({ title: `Move Song C ${Date.now()}` });

    await addSongToSetlist(setlist.id, songA.id); // position 1
    await addSongToSetlist(setlist.id, songB.id); // position 2
    await addSongToSetlist(setlist.id, songC.id); // position 3

    expect(await moveSetlistSong(setlist.id, songC.id, 1)).toBe(true);

    const entries = await getSetlistSongs(setlist.id);
    expect(entries.map((entry) => entry.song.id)).toEqual([songC.id, songA.id, songB.id]);
    expect(entries.map((entry) => entry.position)).toEqual([1, 2, 3]);
  });

  it('returns false when moving a song not in the setlist', async () => {
    const setlist = await addSetlist({ name: `Move Missing ${Date.now()}` });
    const song = await addSong({ title: `Move Missing Song ${Date.now()}` });

    expect(await moveSetlistSong(setlist.id, song.id, 1)).toBe(false);
  });

  it('removes a song from a setlist and re-closes position gaps', async () => {
    const setlist = await addSetlist({ name: `Remove Gap ${Date.now()}` });
    const songA = await addSong({ title: `Remove Gap Song A ${Date.now()}` });
    const songB = await addSong({ title: `Remove Gap Song B ${Date.now()}` });
    const songC = await addSong({ title: `Remove Gap Song C ${Date.now()}` });

    await addSongToSetlist(setlist.id, songA.id); // position 1
    await addSongToSetlist(setlist.id, songB.id); // position 2
    await addSongToSetlist(setlist.id, songC.id); // position 3

    expect(await removeSongFromSetlist(setlist.id, songB.id)).toBe(true);

    const entries = await getSetlistSongs(setlist.id);
    expect(entries.map((entry) => entry.song.id)).toEqual([songA.id, songC.id]);
    expect(entries.map((entry) => entry.position)).toEqual([1, 2]);
  });

  it('returns false when removing a song not in the setlist', async () => {
    const setlist = await addSetlist({ name: `Remove Missing ${Date.now()}` });
    const song = await addSong({ title: `Remove Missing Song ${Date.now()}` });

    expect(await removeSongFromSetlist(setlist.id, song.id)).toBe(false);
  });

  it('deleting a song removes its setlist_songs entries', async () => {
    const setlist = await addSetlist({ name: `Song Delete Cascade ${Date.now()}` });
    const songA = await addSong({ title: `Song Delete Cascade A ${Date.now()}` });
    const songB = await addSong({ title: `Song Delete Cascade B ${Date.now()}` });

    await addSongToSetlist(setlist.id, songA.id);
    await addSongToSetlist(setlist.id, songB.id);

    expect(await deleteSong(songA.id)).toBe(true);

    const entries = await getSetlistSongs(setlist.id);
    expect(entries.map((entry) => entry.song.id)).toEqual([songB.id]);
  });

  it('deleteSetlist cascades its setlist_songs entries then removes itself', async () => {
    const setlist = await addSetlist({ name: `Setlist Delete Cascade ${Date.now()}` });
    const song = await addSong({ title: `Setlist Delete Cascade Song ${Date.now()}` });

    await addSongToSetlist(setlist.id, song.id);

    expect(await deleteSetlist(setlist.id)).toBe(true);
    expect(await getSetlistByName(setlist.name)).toBeUndefined();
    expect(await getSetlistSongs(setlist.id)).toEqual([]);
  });

  it('returns false when deleting a missing setlist', async () => {
    expect(await deleteSetlist(999_999)).toBe(false);
  });
});
