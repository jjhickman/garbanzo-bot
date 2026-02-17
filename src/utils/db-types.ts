/**
 * Shared database domain types used by all backends.
 *
 * Keep this file backend-agnostic so sqlite and postgres implementations
 * can share the exact same API contract.
 */

export interface DbMessage {
  sender: string;
  text: string;
  timestamp: number;
}

export interface ModerationEntry {
  chatJid: string;
  sender: string;
  text: string;
  reason: string;
  severity: string;
  source: string;
  timestamp: number;
}

export interface StrikeSummary {
  sender: string;
  strike_count: number;
  last_flag: number;
  reasons: string;
}

export interface FeedbackEntry {
  id: number;
  type: 'suggestion' | 'bug';
  sender: string;
  group_jid: string | null;
  text: string;
  status: 'open' | 'accepted' | 'rejected' | 'done';
  upvotes: number;
  upvoters: string;
  github_issue_number: number | null;
  github_issue_url: string | null;
  github_issue_created_at: number | null;
  timestamp: number;
}

export interface MemoryEntry {
  id: number;
  fact: string;
  category: string;
  source: string;
  created_at: number;
}

export interface DailyGroupActivity {
  chatJid: string;
  messageCount: number;
  activeUsers: number;
}

export interface MemberProfile {
  jid: string;
  name: string | null;
  interests: string; // JSON array of strings
  groups_active: string; // JSON array of group JIDs
  event_count: number;
  first_seen: number;
  last_seen: number;
  opted_in: number; // 0 or 1
}

export interface BackupIntegrityStatus {
  available: boolean;
  path: string | null;
  modifiedAt: number | null;
  ageHours: number | null;
  sizeBytes: number | null;
  integrityOk: boolean | null;
  message: string;
}

export interface MaintenanceStats {
  pruned: number;
  beforeCount: number;
  afterCount: number;
}

export interface SessionSummaryHit {
  sessionId: number;
  startedAt: number;
  endedAt: number;
  messageCount: number;
  participants: string[];
  topicTags: string[];
  summaryText: string;
  score: number;
}
