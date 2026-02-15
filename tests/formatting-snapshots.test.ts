import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Formatted output snapshots', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('help message snapshot stays stable', async () => {
    const { getHelpMessage, getOwnerHelpMessage } = await import('../src/features/help.js');
    expect(getHelpMessage()).toMatchSnapshot('member-help');
    expect(getOwnerHelpMessage()).toMatchSnapshot('owner-help');
  });

  it('profile display snapshot stays stable', async () => {
    vi.doMock('../src/utils/db.js', () => ({
      touchProfile: vi.fn(),
      setProfileInterests: vi.fn(),
      setProfileName: vi.fn(),
      deleteProfileData: vi.fn(),
      getProfile: vi.fn(() => ({
        jid: 'user@s.whatsapp.net',
        name: 'Alex',
        interests: JSON.stringify(['hiking', 'trivia', 'board games']),
        groups_active: JSON.stringify(['general@g.us', 'events@g.us']),
        event_count: 4,
        first_seen: 1735689600,
        last_seen: 1735776000,
        opted_in: 1,
      })),
    }));

    vi.doMock('../src/bot/groups.js', () => ({
      getGroupName: vi.fn((jid: string) => {
        if (jid === 'general@g.us') return 'General';
        if (jid === 'events@g.us') return 'Events';
        return jid;
      }),
    }));

    const { handleProfile } = await import('../src/features/profiles.js');
    expect(handleProfile('', 'user@s.whatsapp.net')).toMatchSnapshot('profile-view');
  });

  it('memory list snapshot stays stable', async () => {
    vi.doMock('../src/utils/db.js', () => ({
      addMemory: vi.fn(),
      deleteMemory: vi.fn(),
      searchMemory: vi.fn(),
      getAllMemories: vi.fn(() => [
        { id: 1, fact: 'Trivia night is Wednesdays at 7 PM', category: 'events', source: 'owner', created_at: 1735689600 },
        { id: 2, fact: 'Parlor in Cambridge has great vibes', category: 'venues', source: 'owner', created_at: 1735689601 },
        { id: 3, fact: 'Book club meets every second Sunday', category: 'traditions', source: 'owner', created_at: 1735689602 },
      ]),
    }));

    const { handleMemory } = await import('../src/features/memory.js');
    expect(handleMemory('')).toMatchSnapshot('memory-list');
  });
});
