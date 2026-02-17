-- Garbanzo Postgres schema (phase 1 bootstrap)

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  timestamp BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_ts
  ON messages (chat_jid, timestamp DESC);

CREATE TABLE IF NOT EXISTS conversation_sessions (
  id BIGSERIAL PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  ended_at BIGINT NOT NULL,
  message_count INTEGER NOT NULL,
  participants JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary_text TEXT,
  topic_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary_version INTEGER NOT NULL DEFAULT 1,
  summary_created_at BIGINT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'summarized', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_chat_end
  ON conversation_sessions (chat_jid, ended_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_chat_status
  ON conversation_sessions (chat_jid, status);

CREATE TABLE IF NOT EXISTS moderation_log (
  id BIGSERIAL PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  reason TEXT NOT NULL,
  severity TEXT NOT NULL,
  source TEXT NOT NULL,
  timestamp BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_moderation_ts
  ON moderation_log (timestamp DESC);

CREATE TABLE IF NOT EXISTS daily_stats (
  id BIGSERIAL PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  id BIGSERIAL PRIMARY KEY,
  fact TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  source TEXT NOT NULL DEFAULT 'owner',
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_category
  ON memory (category);

CREATE TABLE IF NOT EXISTS member_profiles (
  jid TEXT PRIMARY KEY,
  name TEXT,
  interests JSONB NOT NULL DEFAULT '[]'::jsonb,
  groups_active JSONB NOT NULL DEFAULT '[]'::jsonb,
  event_count INTEGER NOT NULL DEFAULT 0,
  first_seen BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  opted_in SMALLINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS feedback (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('suggestion', 'bug')),
  sender TEXT NOT NULL,
  group_jid TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'done')),
  upvotes INTEGER NOT NULL DEFAULT 0,
  upvoters JSONB NOT NULL DEFAULT '[]'::jsonb,
  github_issue_number INTEGER,
  github_issue_url TEXT,
  github_issue_created_at BIGINT,
  timestamp BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_status
  ON feedback (status, timestamp DESC);
