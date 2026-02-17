import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.DB_DIALECT = 'postgres';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const describePostgres = hasDatabase ? describe : describe.skip;

type DbModule = typeof import('../src/utils/db.js');
type PgClient = {
  query: (text: string, values?: readonly unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  end: () => Promise<void>;
};

function todayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

describePostgres('Postgres backend parity', () => {
  let db: DbModule;
  let client: PgClient;

  beforeAll(async () => {
    const { Client } = await import('pg');
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    db = await import('../src/utils/db.js');
  });

  beforeEach(async () => {
    await client.query(
      'TRUNCATE TABLE feedback, moderation_log, messages, memory, member_profiles, daily_stats RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await db.closeDb();
    await client.end();
  });

  it('stores and retrieves profile information', async () => {
    const senderJid = '15550000001@s.whatsapp.net';

    await db.touchProfile(senderJid);
    await db.setProfileName(senderJid, 'Postgres Tester');
    await db.setProfileInterests(senderJid, ['hiking', 'trivia']);
    await db.updateActiveGroups(senderJid, 'postgres-group@g.us');

    const profile = await db.getProfile(senderJid);
    expect(profile).toBeDefined();
    expect(profile?.jid).toBe('15550000001');
    expect(profile?.name).toBe('Postgres Tester');
    expect(JSON.parse(profile?.interests ?? '[]')).toEqual(['hiking', 'trivia']);
    expect(JSON.parse(profile?.groups_active ?? '[]')).toContain('postgres-group@g.us');
  });

  it('stores message history with per-chat pruning and daily aggregation', async () => {
    const chatJid = `pg-history-${Date.now()}@g.us`;

    for (let i = 0; i < 105; i += 1) {
      await db.storeMessage(chatJid, '15550000002@s.whatsapp.net', `message-${i}`);
    }

    const messages = await db.getMessages(chatJid, 200);
    expect(messages.length).toBe(105);
    expect(messages[0]?.text).toBe('message-0');
    expect(messages[messages.length - 1]?.text).toBe('message-104');

    const activity = await db.getDailyGroupActivity(todayDateString());
    const row = activity.find((item) => item.chatJid === chatJid);
    expect(row).toBeDefined();
    expect(row?.messageCount).toBe(105);
    expect(row?.activeUsers).toBe(1);
  });

  it('handles feedback lifecycle and upvote dedupe', async () => {
    const entry = await db.submitFeedback(
      'suggestion',
      '15550000003@s.whatsapp.net',
      'postgres-feedback@g.us',
      'Add postgres verification dashboard command',
    );

    const firstVote = await db.upvoteFeedback(entry.id, '15550000004@s.whatsapp.net');
    const secondVote = await db.upvoteFeedback(entry.id, '15550000004@s.whatsapp.net');
    expect(firstVote).toBe(true);
    expect(secondVote).toBe(false);

    const linked = await db.linkFeedbackToGitHubIssue(entry.id, 42, 'https://github.com/example/repo/issues/42');
    expect(linked).toBe(true);

    const statusUpdated = await db.setFeedbackStatus(entry.id, 'accepted');
    expect(statusUpdated).toBe(true);

    const updated = await db.getFeedbackById(entry.id);
    expect(updated?.status).toBe('accepted');
    expect(updated?.upvotes).toBe(1);
    expect(updated?.github_issue_number).toBe(42);
  });

  it('supports memory storage, prompt formatting, and relevant retrieval', async () => {
    await db.addMemory('Trivia is strongest on Wednesdays', 'events', 'owner');
    await db.addMemory('Preferred venue is in Cambridge', 'venues', 'owner');

    const search = await db.searchMemory('Wednesdays');
    expect(search.length).toBeGreaterThanOrEqual(1);

    const formatted = await db.formatMemoriesForPrompt();
    expect(formatted).toContain('Community knowledge');
    expect(formatted).toContain('events');
    expect(formatted).toContain('Trivia is strongest on Wednesdays');

    const chatJid = `pg-context-${Date.now()}@g.us`;
    await db.storeMessage(chatJid, '15550000002@s.whatsapp.net', 'Trivia night is Wednesdays at 7 PM in Cambridge.');
    await db.storeMessage(chatJid, '15550000003@s.whatsapp.net', 'We should bike to the venue if weather is good.');

    const relevant = await db.searchRelevantMessages(chatJid, 'When is trivia night?', 2);
    expect(relevant.length).toBeGreaterThan(0);
    expect(relevant[0]?.text).toContain('Trivia');
  });

  it('runs maintenance and reports backup integrity status', async () => {
    const oldTs = Math.floor(Date.now() / 1000) - (40 * 24 * 60 * 60);
    await client.query(
      'INSERT INTO messages (chat_jid, sender, text, timestamp) VALUES ($1, $2, $3, $4)',
      ['maintenance@g.us', '15550000005', 'old-message', oldTs],
    );

    const stats = await db.runMaintenance();
    expect(stats.pruned).toBeGreaterThanOrEqual(1);

    const marker = await db.backupDatabase();
    expect(marker.startsWith('postgres-managed-backup:')).toBe(true);

    const integrity = await db.verifyLatestBackupIntegrity();
    expect(integrity.integrityOk).toBe(true);
  });
});
