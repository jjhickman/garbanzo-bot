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

CREATE TABLE IF NOT EXISTS event_reminders (
  id BIGSERIAL PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  activity TEXT NOT NULL,
  location TEXT,
  event_at BIGINT NOT NULL,
  remind_at BIGINT NOT NULL,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'cancelled')),
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_reminders_status_remind
  ON event_reminders (status, remind_at ASC);

CREATE INDEX IF NOT EXISTS idx_event_reminders_status_event
  ON event_reminders (status, event_at ASC);

CREATE TABLE IF NOT EXISTS whatsapp_outbound_jobs (
  id BIGSERIAL PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_json TEXT NOT NULL,
  options_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'held', 'failed', 'discarded')),
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  sent_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbound_status_created
  ON whatsapp_outbound_jobs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbound_sent_at
  ON whatsapp_outbound_jobs (sent_at DESC);

CREATE TABLE IF NOT EXISTS whatsapp_safety_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  paused SMALLINT NOT NULL DEFAULT 0,
  risk TEXT NOT NULL DEFAULT 'low'
    CHECK (risk IN ('low', 'medium', 'high', 'critical')),
  score INTEGER NOT NULL DEFAULT 0,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at BIGINT NOT NULL DEFAULT 0
);

INSERT INTO whatsapp_safety_state (id, paused, risk, score, reasons, updated_at)
  VALUES (1, 0, 'low', 0, '[]'::jsonb, 0)
  ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS songs (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  song_key TEXT,
  tempo INTEGER,
  status TEXT NOT NULL DEFAULT 'idea'
    CHECK (status IN ('idea', 'rough', 'tight', 'gig-ready')),
  notes TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_songs_title_lower
  ON songs (lower(title));

CREATE INDEX IF NOT EXISTS idx_songs_status
  ON songs (status);

CREATE TABLE IF NOT EXISTS rehearsals (
  id BIGSERIAL PRIMARY KEY,
  scheduled_at BIGINT NOT NULL,
  location TEXT,
  agenda TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','done','cancelled')),
  reminder_sent BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rehearsals_status_scheduled
  ON rehearsals (status, scheduled_at);

CREATE TABLE IF NOT EXISTS availability (
  id BIGSERIAL PRIMARY KEY,
  rehearsal_id BIGINT NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  member_name TEXT,
  response TEXT NOT NULL CHECK (response IN ('yes','no','maybe')),
  responded_at BIGINT NOT NULL,
  UNIQUE(rehearsal_id, member_id)
);
