import type {
  Availability,
  AvailabilityResponse,
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
  Rehearsal,
  RehearsalStatus,
  Setlist,
  SetlistEntry,
  SetlistSong,
  Song,
  SongStatus,
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

  // Songs (shared band memory)
  addSong(input: { title: string; key?: string | null; tempo?: number | null; status?: SongStatus; notes?: string | null }): Promise<Song>;
  getSongById(id: number): Promise<Song | undefined>;
  getSongByTitle(title: string): Promise<Song | undefined>;
  listSongs(status?: SongStatus): Promise<Song[]>;
  updateSong(id: number, patch: Partial<{ title: string; key: string | null; tempo: number | null; status: SongStatus; notes: string | null }>): Promise<Song | undefined>;
  deleteSong(id: number): Promise<boolean>;

  // Rehearsals (shared band practice memory)
  addRehearsal(input: { scheduledAt: number; location?: string | null; agenda?: string | null; createdBy?: string | null }): Promise<Rehearsal>;
  getRehearsalById(id: number): Promise<Rehearsal | undefined>;
  listUpcomingRehearsals(nowSeconds: number, limit?: number): Promise<Rehearsal[]>;
  getNextRehearsal(nowSeconds: number): Promise<Rehearsal | undefined>;
  updateRehearsal(id: number, patch: Partial<{ scheduledAt: number; location: string | null; agenda: string | null; status: RehearsalStatus }>): Promise<Rehearsal | undefined>;
  cancelRehearsal(id: number): Promise<boolean>;
  listRehearsalsNeedingReminder(nowSeconds: number): Promise<Rehearsal[]>;
  markRehearsalReminderSent(id: number): Promise<boolean>;

  // Availability (per-rehearsal band member RSVPs)
  setAvailability(rehearsalId: number, memberId: string, memberName: string | null, response: AvailabilityResponse): Promise<Availability>;
  listAvailability(rehearsalId: number): Promise<Availability[]>;

  // Setlists (ordered song lists referencing shared band songs)
  addSetlist(input: { name: string; notes?: string | null }): Promise<Setlist>;
  getSetlistByName(name: string): Promise<Setlist | undefined>;
  listSetlists(): Promise<Setlist[]>;
  deleteSetlist(id: number): Promise<boolean>;
  addSongToSetlist(setlistId: number, songId: number, position?: number): Promise<SetlistSong>;
  removeSongFromSetlist(setlistId: number, songId: number): Promise<boolean>;
  moveSetlistSong(setlistId: number, songId: number, newPosition: number): Promise<boolean>;
  getSetlistSongs(setlistId: number): Promise<SetlistEntry[]>;

  // Lifecycle
  closeDb(): Promise<void>;
}
