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

export interface LocalMemoryEntry {
  id: number;
  fact: string;
  category: string;
  source: string;
  created_at: number;
  shared?: false;
}

export interface SharedMemoryEntry {
  fact: string;
  category: string;
  source: 'shared';
  created_at: number;
  shared: true;
  originInstance: string;
}

export type MemoryEntry = LocalMemoryEntry | SharedMemoryEntry;

export type SongStatus = 'idea' | 'rough' | 'tight' | 'gig-ready';

export interface Song {
  id: number;
  title: string;
  key: string | null;
  tempo: number | null;
  status: SongStatus;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

export type RehearsalStatus = 'scheduled' | 'done' | 'cancelled';

export interface Rehearsal {
  id: number;
  scheduledAt: number;
  location: string | null;
  agenda: string | null;
  status: RehearsalStatus;
  reminderSent: boolean;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export type AvailabilityResponse = 'yes' | 'no' | 'maybe';

export interface Availability {
  id: number;
  rehearsalId: number;
  memberId: string;
  memberName: string | null;
  response: AvailabilityResponse;
  respondedAt: number;
}

export interface Setlist {
  id: number;
  name: string;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SetlistSong {
  id: number;
  setlistId: number;
  songId: number;
  position: number;
}

export interface SetlistEntry {
  position: number;
  song: Song;
}

export type SectionKind = 'intro' | 'verse' | 'chorus' | 'bridge' | 'solo' | 'outro' | 'other';

export interface SongSection {
  id: number;
  songId: number;
  kind: SectionKind;
  position: number;
  lyrics: string | null;
  chords: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SongIdea {
  id: number;
  title: string | null;
  text: string | null;
  audioUrl: string | null;
  transcript: string | null;
  songId: number | null;
  createdBy: string | null;
  createdAt: number;
}

export interface DailyGroupActivity {
  chatJid: string;
  messageCount: number;
  activeUsers: number;
}

export type EventReminderStatus = 'pending' | 'sent' | 'cancelled';

export interface NewEventReminder {
  chatJid: string;
  activity: string;
  location: string | null;
  eventAt: number;
  remindAt: number;
  createdBy: string;
}

export interface EventReminder extends NewEventReminder {
  id: number;
  status: EventReminderStatus;
  createdAt: number;
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

/**
 * A summarized conversation session enumerated for vector backfill. Unlike
 * SessionSummaryHit, it carries chatJid (backfill runs across all chats) and
 * has no relevance score (it's a full listing, not a query result).
 */
export interface BackfillSession {
  sessionId: number;
  chatJid: string;
  startedAt: number;
  endedAt: number;
  messageCount: number;
  participants: string[];
  topicTags: string[];
  summaryText: string;
}

export type WhatsAppOutboundStatus = 'pending' | 'sent' | 'held' | 'failed' | 'discarded';
export type WhatsAppRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface WhatsAppOutboundJob {
  id: number;
  chatJid: string;
  kind: string;
  contentJson: string;
  optionsJson: string | null;
  status: WhatsAppOutboundStatus;
  reason: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
}

export interface WhatsAppSafetyState {
  paused: boolean;
  risk: WhatsAppRiskLevel;
  score: number;
  reasons: string[];
  updatedAt: number;
}

export interface WhatsAppSafetyMetrics {
  pending: number;
  held: number;
  sentLastHour: number;
  sentLastDay: number;
  failedLastHour: number;
  paused: boolean;
  risk: WhatsAppRiskLevel;
  score: number;
}

export type BridgeOutboxStatus = 'pending' | 'sent' | 'dead';

export interface BridgeOutboxEntry {
  id: number;
  envelopeJson: string;
  targetInstance: string;
  status: BridgeOutboxStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
}

export interface BridgeOutboxCounts {
  pending: number;
  sent: number;
  dead: number;
}
