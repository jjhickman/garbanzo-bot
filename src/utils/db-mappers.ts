import type {
  Availability,
  AvailabilityResponse,
  BridgeBufferEntry,
  BridgeOutboxEntry,
  BridgeOutboxStatus,
  DailyGroupActivity,
  DbMessage,
  EventReminder,
  EventReminderStatus,
  FeedbackEntry,
  MemberProfile,
  LocalMemoryEntry,
  NativeEvent,
  NativeEventStatus,
  Rehearsal,
  RehearsalStatus,
  SectionKind,
  SessionSummaryHit,
  Setlist,
  SetlistEntry,
  SetlistSong,
  Song,
  SongIdea,
  SongSection,
  SongStatus,
  StrikeSummary,
  WhatsAppOutboundJob,
  WhatsAppOutboundStatus,
  WhatsAppRiskLevel,
  WhatsAppSafetyState,
} from './db-types.js';
import { parseJsonArray, toJsonArrayString, toNumber, type DbNumeric } from './db-query-shape.js';

export interface MessageRow {
  sender: string;
  text: string;
  timestamp: DbNumeric | null;
}

export interface SessionSummaryRow {
  id: DbNumeric | null;
  started_at: DbNumeric | null;
  ended_at: DbNumeric | null;
  message_count: DbNumeric | null;
  participants: unknown;
  summary_text: string;
  topic_tags: unknown;
}

export interface StrikeSummaryRow {
  sender: string;
  strike_count: DbNumeric | null;
  last_flag: DbNumeric | null;
  reasons: string | null;
}

export interface DailyGroupActivityRow {
  chatJid?: string;
  chatjid?: string;
  messageCount?: DbNumeric | null;
  messagecount?: DbNumeric | null;
  activeUsers?: DbNumeric | null;
  activeusers?: DbNumeric | null;
}

export interface ProfileRow {
  jid: string;
  name: string | null;
  interests: unknown;
  groups_active: unknown;
  event_count: DbNumeric | null;
  first_seen: DbNumeric | null;
  last_seen: DbNumeric | null;
  opted_in: DbNumeric | null;
}

export interface FeedbackRow {
  id: DbNumeric | null;
  type: 'suggestion' | 'bug';
  sender: string;
  group_jid: string | null;
  text: string;
  status: 'open' | 'accepted' | 'rejected' | 'done';
  upvotes: DbNumeric | null;
  upvoters: unknown;
  github_issue_number: number | null;
  github_issue_url: string | null;
  github_issue_created_at: DbNumeric | null;
  timestamp: DbNumeric | null;
}

export interface MemoryRow {
  id: DbNumeric | null;
  fact: string;
  category: string;
  source: string;
  created_at: DbNumeric | null;
}

export interface SongRow {
  id: DbNumeric | null;
  title: string;
  song_key: string | null;
  tempo: DbNumeric | null;
  status: SongStatus;
  notes: string | null;
  created_at: DbNumeric | null;
  updated_at: DbNumeric | null;
}

export interface RehearsalRow {
  id: DbNumeric | null;
  scheduled_at: DbNumeric | null;
  location: string | null;
  agenda: string | null;
  status: RehearsalStatus;
  reminder_sent: DbNumeric | boolean | null;
  created_by: string | null;
  created_at: DbNumeric | null;
  updated_at: DbNumeric | null;
}

export interface AvailabilityRow {
  id: DbNumeric | null;
  rehearsal_id: DbNumeric | null;
  member_id: string;
  member_name: string | null;
  response: AvailabilityResponse;
  responded_at: DbNumeric | null;
}

export interface SetlistRow {
  id: DbNumeric | null;
  name: string;
  notes: string | null;
  created_at: DbNumeric | null;
  updated_at: DbNumeric | null;
}

export interface SetlistSongRow {
  id: DbNumeric | null;
  setlist_id: DbNumeric | null;
  song_id: DbNumeric | null;
  position: DbNumeric | null;
}

/** A setlist_songs row JOINed with its referenced songs row (position + full song columns). */
export interface SetlistEntryRow extends SongRow {
  position: DbNumeric | null;
}

export interface SongIdeaRow {
  id: DbNumeric | null;
  title: string | null;
  text: string | null;
  audio_url: string | null;
  transcript: string | null;
  song_id: DbNumeric | null;
  created_by: string | null;
  created_at: DbNumeric | null;
}

export interface SongSectionRow {
  id: DbNumeric | null;
  song_id: DbNumeric | null;
  kind: SectionKind;
  position: DbNumeric | null;
  lyrics: string | null;
  chords: string | null;
  created_at: DbNumeric | null;
  updated_at: DbNumeric | null;
}

export interface NativeEventRow {
  id: DbNumeric | null;
  chat_id: string;
  platform: string;
  name: string;
  description: string | null;
  location: string | null;
  start_at_ms: DbNumeric | null;
  end_at_ms: DbNumeric | null;
  platform_ref: string;
  status: NativeEventStatus;
  reminder_id: DbNumeric | null;
  created_by: string;
  created_at: DbNumeric | null;
}

export interface EventReminderRow {
  id: DbNumeric | null;
  chat_jid: string;
  activity: string;
  location: string | null;
  event_at: DbNumeric | null;
  remind_at: DbNumeric | null;
  created_by: string;
  status: EventReminderStatus;
  created_at: DbNumeric | null;
}

export interface WhatsAppOutboundRow {
  id: DbNumeric | null;
  chat_jid: string;
  kind: string;
  content_json: string;
  options_json: string | null;
  status: WhatsAppOutboundStatus;
  reason: string | null;
  attempts: DbNumeric | null;
  created_at: DbNumeric | null;
  updated_at: DbNumeric | null;
  sent_at: DbNumeric | null;
}

export interface WhatsAppSafetyStateRow {
  paused: DbNumeric | null;
  risk: WhatsAppRiskLevel;
  score: DbNumeric | null;
  reasons: unknown;
  updated_at: DbNumeric | null;
}

export interface BridgeOutboxRow {
  id: DbNumeric | null;
  envelope_json: string;
  target_instance: string;
  status: BridgeOutboxStatus;
  attempts: DbNumeric | null;
  next_attempt_at: DbNumeric | null;
  last_error: string | null;
  created_at: DbNumeric | null;
}

export interface BridgeBufferRow {
  id: DbNumeric | null;
  route_id: string;
  envelope_json: string;
  buffered_at: DbNumeric | null;
}

export function mapDbMessage(row: MessageRow): DbMessage {
  return {
    sender: row.sender,
    text: row.text,
    timestamp: toNumber(row.timestamp),
  };
}

export function mapSessionSummaryHit(row: SessionSummaryRow, score: number): SessionSummaryHit {
  return {
    sessionId: toNumber(row.id),
    startedAt: toNumber(row.started_at),
    endedAt: toNumber(row.ended_at),
    messageCount: toNumber(row.message_count),
    participants: parseJsonArray(row.participants),
    topicTags: parseJsonArray(row.topic_tags),
    summaryText: row.summary_text,
    score,
  };
}

export function mapStrikeSummary(row: StrikeSummaryRow): StrikeSummary {
  return {
    sender: row.sender,
    strike_count: toNumber(row.strike_count),
    last_flag: toNumber(row.last_flag),
    reasons: row.reasons ?? '',
  };
}

export function mapDailyGroupActivity(row: DailyGroupActivityRow): DailyGroupActivity {
  return {
    chatJid: row.chatJid ?? row.chatjid ?? '',
    messageCount: toNumber(row.messageCount ?? row.messagecount),
    activeUsers: toNumber(row.activeUsers ?? row.activeusers),
  };
}

export function mapMemberProfile(row: ProfileRow): MemberProfile {
  return {
    jid: row.jid,
    name: row.name,
    interests: toJsonArrayString(row.interests),
    groups_active: toJsonArrayString(row.groups_active),
    event_count: toNumber(row.event_count),
    first_seen: toNumber(row.first_seen),
    last_seen: toNumber(row.last_seen),
    opted_in: toNumber(row.opted_in),
  };
}

export function mapFeedbackEntry(row: FeedbackRow): FeedbackEntry {
  return {
    id: toNumber(row.id),
    type: row.type,
    sender: row.sender,
    group_jid: row.group_jid,
    text: row.text,
    status: row.status,
    upvotes: toNumber(row.upvotes),
    upvoters: toJsonArrayString(row.upvoters),
    github_issue_number: row.github_issue_number,
    github_issue_url: row.github_issue_url,
    github_issue_created_at: row.github_issue_created_at === null ? null : toNumber(row.github_issue_created_at),
    timestamp: toNumber(row.timestamp),
  };
}

export function mapMemoryEntry(row: MemoryRow): LocalMemoryEntry {
  return {
    id: toNumber(row.id),
    fact: row.fact,
    category: row.category,
    source: row.source,
    created_at: toNumber(row.created_at),
  };
}

export function mapSong(row: SongRow): Song {
  return {
    id: toNumber(row.id),
    title: row.title,
    key: row.song_key,
    tempo: row.tempo === null ? null : toNumber(row.tempo),
    status: row.status,
    notes: row.notes,
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
  };
}

export function mapSongIdea(row: SongIdeaRow): SongIdea {
  return {
    id: toNumber(row.id),
    title: row.title,
    text: row.text,
    audioUrl: row.audio_url,
    transcript: row.transcript,
    songId: row.song_id === null ? null : toNumber(row.song_id),
    createdBy: row.created_by,
    createdAt: toNumber(row.created_at),
  };
}

export function mapRehearsal(row: RehearsalRow): Rehearsal {
  const reminderSent = typeof row.reminder_sent === 'boolean'
    ? row.reminder_sent
    : toNumber(row.reminder_sent) === 1;

  return {
    id: toNumber(row.id),
    scheduledAt: toNumber(row.scheduled_at),
    location: row.location,
    agenda: row.agenda,
    status: row.status,
    reminderSent,
    createdBy: row.created_by,
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
  };
}

export function mapAvailability(row: AvailabilityRow): Availability {
  return {
    id: toNumber(row.id),
    rehearsalId: toNumber(row.rehearsal_id),
    memberId: row.member_id,
    memberName: row.member_name,
    response: row.response,
    respondedAt: toNumber(row.responded_at),
  };
}

export function mapSetlist(row: SetlistRow): Setlist {
  return {
    id: toNumber(row.id),
    name: row.name,
    notes: row.notes,
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
  };
}

export function mapSetlistSong(row: SetlistSongRow): SetlistSong {
  return {
    id: toNumber(row.id),
    setlistId: toNumber(row.setlist_id),
    songId: toNumber(row.song_id),
    position: toNumber(row.position),
  };
}

export function mapSetlistEntry(row: SetlistEntryRow): SetlistEntry {
  return {
    position: toNumber(row.position),
    song: mapSong(row),
  };
}

export function mapSongSection(row: SongSectionRow): SongSection {
  return {
    id: toNumber(row.id),
    songId: toNumber(row.song_id),
    kind: row.kind,
    position: toNumber(row.position),
    lyrics: row.lyrics,
    chords: row.chords,
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
  };
}

export function mapNativeEvent(row: NativeEventRow): NativeEvent {
  return {
    id: toNumber(row.id),
    chatId: row.chat_id,
    platform: row.platform,
    name: row.name,
    description: row.description,
    location: row.location,
    startAtMs: toNumber(row.start_at_ms),
    endAtMs: row.end_at_ms === null ? null : toNumber(row.end_at_ms),
    platformRef: row.platform_ref,
    status: row.status,
    reminderId: row.reminder_id === null ? null : toNumber(row.reminder_id),
    createdBy: row.created_by,
    createdAt: toNumber(row.created_at),
  };
}

export function mapEventReminder(row: EventReminderRow): EventReminder {
  return {
    id: toNumber(row.id),
    chatJid: row.chat_jid,
    activity: row.activity,
    location: row.location,
    eventAt: toNumber(row.event_at),
    remindAt: toNumber(row.remind_at),
    createdBy: row.created_by,
    status: row.status,
    createdAt: toNumber(row.created_at),
  };
}

export function mapWhatsAppOutboundJob(row: WhatsAppOutboundRow): WhatsAppOutboundJob {
  return {
    id: toNumber(row.id),
    chatJid: row.chat_jid,
    kind: row.kind,
    contentJson: row.content_json,
    optionsJson: row.options_json,
    status: row.status,
    reason: row.reason,
    attempts: toNumber(row.attempts),
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
    sentAt: row.sent_at === null ? null : toNumber(row.sent_at),
  };
}

export function mapWhatsAppSafetyState(row: WhatsAppSafetyStateRow): WhatsAppSafetyState {
  return {
    paused: toNumber(row.paused) === 1,
    risk: row.risk,
    score: toNumber(row.score),
    reasons: parseJsonArray(row.reasons),
    updatedAt: toNumber(row.updated_at),
  };
}

export function mapBridgeOutboxEntry(row: BridgeOutboxRow): BridgeOutboxEntry {
  return {
    id: toNumber(row.id),
    envelopeJson: row.envelope_json,
    targetInstance: row.target_instance,
    status: row.status,
    attempts: toNumber(row.attempts),
    nextAttemptAt: toNumber(row.next_attempt_at),
    lastError: row.last_error,
    createdAt: toNumber(row.created_at),
  };
}

export function mapBridgeBufferEntry(row: BridgeBufferRow): BridgeBufferEntry {
  return {
    id: toNumber(row.id),
    routeId: row.route_id,
    envelopeJson: row.envelope_json,
    bufferedAt: toNumber(row.buffered_at),
  };
}
