process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { describe, expect, it, vi } from 'vitest';

/**
 * Band songwriting — song_sections table (sqlite backend, real db via the
 * shared `src/utils/db.js` barrel, mirroring tests/setlists-db.test.ts —
 * the closest template: FK child of songs, position, UNIQUE(parent,
 * position), transactional reorder).
 */

describe('Song sections — per-song structure (intro/verse/chorus/...)', async () => {
  const {
    addSong,
    deleteSong,
    addSongIdea,
    getSongIdeaById,
    addSongSection,
    getSongSections,
    updateSongSection,
    moveSongSection,
    removeSongSection,
  } = await import('../src/utils/db.js');

  it('appends sections to a song with contiguous positions when no position is given', async () => {
    const song = await addSong({ title: `Section Append Song ${Date.now()}` });

    const intro = await addSongSection({ songId: song.id, kind: 'intro' });
    const verse = await addSongSection({ songId: song.id, kind: 'verse' });
    const chorus = await addSongSection({ songId: song.id, kind: 'chorus' });

    expect(intro.position).toBe(1);
    expect(verse.position).toBe(2);
    expect(chorus.position).toBe(3);
    expect(intro.songId).toBe(song.id);
    expect(intro.kind).toBe('intro');
    expect(intro.lyrics).toBeNull();
    expect(intro.chords).toBeNull();
    expect(intro.createdAt).toBeGreaterThan(0);
    expect(intro.updatedAt).toBeGreaterThan(0);
  });

  it('adds a section at an explicit position when given', async () => {
    const song = await addSong({ title: `Section Explicit Position Song ${Date.now()}` });

    const section = await addSongSection({ songId: song.id, kind: 'bridge', position: 5 });
    expect(section.position).toBe(5);
  });

  it('adds a section with lyrics and chords', async () => {
    const song = await addSong({ title: `Section Lyrics Song ${Date.now()}` });

    const section = await addSongSection({
      songId: song.id,
      kind: 'verse',
      lyrics: 'chickpeas in the moonlight',
      chords: 'G D Em C',
    });

    expect(section.lyrics).toBe('chickpeas in the moonlight');
    expect(section.chords).toBe('G D Em C');
  });

  it('gets a song\'s sections ordered by position', async () => {
    const song = await addSong({ title: `Section Ordered Song ${Date.now()}` });

    const intro = await addSongSection({ songId: song.id, kind: 'intro' });
    const verse = await addSongSection({ songId: song.id, kind: 'verse' });
    const outro = await addSongSection({ songId: song.id, kind: 'outro' });

    const sections = await getSongSections(song.id);
    expect(sections.map((s) => s.id)).toEqual([intro.id, verse.id, outro.id]);
    expect(sections.map((s) => s.position)).toEqual([1, 2, 3]);
  });

  it('returns an empty list for a song with no sections', async () => {
    const song = await addSong({ title: `Section Empty Song ${Date.now()}` });
    expect(await getSongSections(song.id)).toEqual([]);
  });

  it('updates only the provided fields on a section and bumps updatedAt', async () => {
    // updatedAt is stored in unix seconds, so a same-second create+update pair
    // would pass a `>= createdAt` check even if the bump logic were removed
    // entirely. Freeze the clock, capture the pre-update timestamp, then jump
    // forward a full second before updating so a missing bump is caught.
    vi.useFakeTimers();
    try {
      const song = await addSong({ title: `Section Update Song ${Date.now()}` });
      const created = await addSongSection({ songId: song.id, kind: 'verse', lyrics: 'draft lyrics' });
      const preUpdateUpdatedAt = created.updatedAt;

      vi.advanceTimersByTime(1_500);

      const updated = await updateSongSection(created.id, { chords: 'C G Am F' });

      expect(updated).toBeDefined();
      expect(updated?.kind).toBe('verse');
      expect(updated?.lyrics).toBe('draft lyrics');
      expect(updated?.chords).toBe('C G Am F');
      expect(updated?.createdAt).toBe(created.createdAt);
      expect(updated?.updatedAt).toBeGreaterThan(preUpdateUpdatedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('patches kind, lyrics, and chords together', async () => {
    const song = await addSong({ title: `Section Patch All Song ${Date.now()}` });
    const created = await addSongSection({ songId: song.id, kind: 'verse' });

    const updated = await updateSongSection(created.id, {
      kind: 'chorus',
      lyrics: 'hook line here',
      chords: 'Am F C G',
    });

    expect(updated?.kind).toBe('chorus');
    expect(updated?.lyrics).toBe('hook line here');
    expect(updated?.chords).toBe('Am F C G');
  });

  it('returns undefined when updating a missing section', async () => {
    expect(await updateSongSection(999_999, { lyrics: 'nope' })).toBeUndefined();
  });

  it('reorders sections with moveSongSection, including moving into an occupied position', async () => {
    const song = await addSong({ title: `Section Move Song ${Date.now()}` });

    const intro = await addSongSection({ songId: song.id, kind: 'intro' }); // 1
    const verse = await addSongSection({ songId: song.id, kind: 'verse' }); // 2
    const chorus = await addSongSection({ songId: song.id, kind: 'chorus' }); // 3
    const outro = await addSongSection({ songId: song.id, kind: 'outro' }); // 4

    // Move outro (position 4) into position 2, an already-occupied position.
    expect(await moveSongSection(outro.id, 2)).toBe(true);

    const sections = await getSongSections(song.id);
    expect(sections.map((s) => s.id)).toEqual([intro.id, outro.id, verse.id, chorus.id]);
    expect(sections.map((s) => s.position)).toEqual([1, 2, 3, 4]);
  });

  it('returns false when moving a missing section', async () => {
    expect(await moveSongSection(999_999, 1)).toBe(false);
  });

  it('removes a section and re-closes position gaps for that song', async () => {
    const song = await addSong({ title: `Section Remove Gap Song ${Date.now()}` });

    const intro = await addSongSection({ songId: song.id, kind: 'intro' }); // 1
    const verse = await addSongSection({ songId: song.id, kind: 'verse' }); // 2
    const chorus = await addSongSection({ songId: song.id, kind: 'chorus' }); // 3

    expect(await removeSongSection(verse.id)).toBe(true);

    const sections = await getSongSections(song.id);
    expect(sections.map((s) => s.id)).toEqual([intro.id, chorus.id]);
    expect(sections.map((s) => s.position)).toEqual([1, 2]);
  });

  it('returns false when removing a missing section', async () => {
    expect(await removeSongSection(999_999)).toBe(false);
  });

  it('does not disturb another song\'s sections when reordering/removing', async () => {
    const songA = await addSong({ title: `Section Isolation A ${Date.now()}` });
    const songB = await addSong({ title: `Section Isolation B ${Date.now()}` });

    const aFirst = await addSongSection({ songId: songA.id, kind: 'intro' });
    const aSecond = await addSongSection({ songId: songA.id, kind: 'verse' });
    const bFirst = await addSongSection({ songId: songB.id, kind: 'intro' });
    const bSecond = await addSongSection({ songId: songB.id, kind: 'verse' });

    expect(await removeSongSection(aFirst.id)).toBe(true);
    expect(await moveSongSection(bSecond.id, 1)).toBe(true);

    const aSections = await getSongSections(songA.id);
    expect(aSections.map((s) => s.id)).toEqual([aSecond.id]);
    expect(aSections.map((s) => s.position)).toEqual([1]);

    const bSections = await getSongSections(songB.id);
    expect(bSections.map((s) => s.id)).toEqual([bSecond.id, bFirst.id]);
    expect(bSections.map((s) => s.position)).toEqual([1, 2]);
  });

  it('accepts every valid SectionKind value', async () => {
    const song = await addSong({ title: `Section Kinds Song ${Date.now()}` });
    const kinds = ['intro', 'verse', 'chorus', 'bridge', 'solo', 'outro', 'other'] as const;

    for (const kind of kinds) {
      const section = await addSongSection({ songId: song.id, kind });
      expect(section.kind).toBe(kind);
    }
  });

  it('deleting a song removes its song_sections and nulls out linked song_ideas.song_id', async () => {
    const song = await addSong({ title: `Section Delete Cascade Song ${Date.now()}` });

    const sectionOne = await addSongSection({ songId: song.id, kind: 'intro' });
    const sectionTwo = await addSongSection({ songId: song.id, kind: 'verse' });
    const idea = await addSongIdea({ text: 'idea linked to a doomed song', songId: song.id });

    expect(await deleteSong(song.id)).toBe(true);

    expect(await getSongSections(song.id)).toEqual([]);
    // Sanity: individual section rows are gone, not just filtered out of the list.
    expect(await updateSongSection(sectionOne.id, { lyrics: 'ghost' })).toBeUndefined();
    expect(await updateSongSection(sectionTwo.id, { lyrics: 'ghost' })).toBeUndefined();

    const fetchedIdea = await getSongIdeaById(idea.id);
    expect(fetchedIdea?.songId).toBeNull();
  });
});
