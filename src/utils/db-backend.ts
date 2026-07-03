import type {
  BackfillSession,
  BackupIntegrityStatus,
  DailyGroupActivity,
  DbMessage,
  EventReminder,
  FeedbackEntry,
  MaintenanceStats,
  MemberProfile,
  MemoryEntry,
  ModerationEntry,
  NewEventReminder,
  StrikeSummary,
  SessionSummaryHit,
  WhatsAppOutboundJob,
  WhatsAppOutboundStatus,
  WhatsAppRiskLevel,
  WhatsAppSafetyMetrics,
  WhatsAppSafetyState,
} from './db-types.js';

/**
 * A database backend implements the storage API Garbanzo features depend on.
 *
 * This interface intentionally matches `src/utils/db.ts` exports.
 */
export interface DbBackend {
  // Profiles
  touchProfile(senderJid: string): Promise<void>;
  getProfile(senderJid: string): Promise<MemberProfile | undefined>;
  setProfileInterests(senderJid: string, interests: string[]): Promise<void>;
  setProfileName(senderJid: string, name: string): Promise<void>;
  updateActiveGroups(senderJid: string, groupJid: string): Promise<void>;
  getOptedInProfiles(): Promise<MemberProfile[]>;
  deleteProfileData(senderJid: string): Promise<void>;

  // Maintenance and backups
  backupDatabase(): Promise<string>;
  runMaintenance(): Promise<MaintenanceStats>;
  verifyLatestBackupIntegrity(): Promise<BackupIntegrityStatus>;
  scheduleMaintenance(): void;
  stopMaintenance(): void;

  // Context
  storeMessage(chatJid: string, sender: string, text: string): Promise<number>;
  getMessages(chatJid: string, limit?: number): Promise<DbMessage[]>;
  searchRelevantMessages(chatJid: string, query: string, limit?: number): Promise<DbMessage[]>;
  searchRelevantSessionSummaries(chatJid: string, query: string, limit?: number): Promise<SessionSummaryHit[]>;
  /** All distinct chat JIDs that have stored messages (for vector backfill enumeration). */
  listMessageChatJids(): Promise<string[]>;
  /** All summarized sessions across every chat (for vector backfill enumeration). */
  listSummarizedSessions(limit?: number): Promise<BackfillSession[]>;

  // Moderation
  logModeration(entry: ModerationEntry): Promise<void>;
  getStrikeCount(senderJid: string): Promise<number>;
  getRepeatOffenders(minStrikes?: number): Promise<StrikeSummary[]>;

  // Daily stats archive
  saveDailyStats(date: string, json: string): Promise<void>;
  /** Archived daily stats snapshots for date >= from AND date <= to (ISO dates sort lexically). */
  loadDailyStatsRange(fromDate: string, toDate: string): Promise<Array<{ date: string; data: string }>>;
  getDailyGroupActivity(date: string): Promise<DailyGroupActivity[]>;

  // Event reminders
  addEventReminder(input: NewEventReminder): Promise<EventReminder>;
  listPendingEventReminders(nowSeconds: number): Promise<EventReminder[]>;
  listUpcomingEventReminders(limit?: number): Promise<EventReminder[]>;
  markEventReminderSent(id: number): Promise<boolean>;
  cancelEventReminder(id: number): Promise<boolean>;

  // WhatsApp outbound safety and retained manual releases
  createWhatsAppOutboundJob(chatJid: string, kind: string, contentJson: string, optionsJson: string | null): Promise<WhatsAppOutboundJob>;
  updateWhatsAppOutboundJob(id: number, status: WhatsAppOutboundStatus, reason?: string | null, sentAt?: number | null): Promise<boolean>;
  getWhatsAppOutboundJob(id: number): Promise<WhatsAppOutboundJob | undefined>;
  listWhatsAppHeldJobs(limit?: number): Promise<WhatsAppOutboundJob[]>;
  recoverWhatsAppPendingJobs(reason: string): Promise<number>;
  countWhatsAppSentSince(since: number): Promise<number>;
  getWhatsAppSafetyState(): Promise<WhatsAppSafetyState>;
  setWhatsAppSafetyState(paused: boolean, risk: WhatsAppRiskLevel, score: number, reasons: string[]): Promise<void>;
  getWhatsAppSafetyMetrics(hourSince: number, daySince: number): Promise<WhatsAppSafetyMetrics>;

  // Feedback
  submitFeedback(type: 'suggestion' | 'bug', sender: string, groupJid: string | null, text: string): Promise<FeedbackEntry>;
  getOpenFeedback(): Promise<FeedbackEntry[]>;
  getRecentFeedback(limit?: number): Promise<FeedbackEntry[]>;
  getFeedbackById(id: number): Promise<FeedbackEntry | undefined>;
  setFeedbackStatus(id: number, status: 'open' | 'accepted' | 'rejected' | 'done'): Promise<boolean>;
  upvoteFeedback(id: number, senderJid: string): Promise<boolean>;
  linkFeedbackToGitHubIssue(id: number, issueNumber: number, issueUrl: string): Promise<boolean>;

  // Memory
  addMemory(fact: string, category?: string, source?: string): Promise<MemoryEntry>;
  getAllMemories(): Promise<MemoryEntry[]>;
  deleteMemory(id: number): Promise<boolean>;
  searchMemory(keyword: string, limit?: number): Promise<MemoryEntry[]>;
  formatMemoriesForPrompt(): Promise<string>;

  // Lifecycle
  closeDb(): Promise<void>;
}
