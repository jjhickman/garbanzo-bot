import type {
  DailyGroupActivity,
  DbMessage,
  EventReminder,
  EventReminderStatus,
  FeedbackEntry,
  MemberProfile,
  MemoryEntry,
  SessionSummaryHit,
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

export function mapMemoryEntry(row: MemoryRow): MemoryEntry {
  return {
    id: toNumber(row.id),
    fact: row.fact,
    category: row.category,
    source: row.source,
    created_at: toNumber(row.created_at),
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
