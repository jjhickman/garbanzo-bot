import type {
  BackupIntegrityStatus,
  DailyGroupActivity,
  DbMessage,
  FeedbackEntry,
  MaintenanceStats,
  MemberProfile,
  MemoryEntry,
  ModerationEntry,
  StrikeSummary,
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
  storeMessage(chatJid: string, sender: string, text: string): Promise<void>;
  getMessages(chatJid: string, limit?: number): Promise<DbMessage[]>;
  searchRelevantMessages(chatJid: string, query: string, limit?: number): Promise<DbMessage[]>;

  // Moderation
  logModeration(entry: ModerationEntry): Promise<void>;
  getStrikeCount(senderJid: string): Promise<number>;
  getRepeatOffenders(minStrikes?: number): Promise<StrikeSummary[]>;

  // Daily stats archive
  saveDailyStats(date: string, json: string): Promise<void>;
  getDailyGroupActivity(date: string): Promise<DailyGroupActivity[]>;

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
