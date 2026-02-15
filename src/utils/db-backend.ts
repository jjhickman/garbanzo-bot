import type {
  DbMessage,
  ModerationEntry,
  StrikeSummary,
  FeedbackEntry,
  MemoryEntry,
} from './db.js';
import type { MemberProfile } from './db.js';

/**
 * A database backend implements the storage API Garbanzo features depend on.
 *
 * This interface intentionally matches the existing `src/utils/db.ts` exports.
 * SQLite is the only implementation today.
 */
export interface DbBackend {
  // Profiles
  touchProfile(senderJid: string, groupJid: string): MemberProfile;
  getProfile(senderJid: string): MemberProfile | null;
  setProfileInterests(senderJid: string, interests: string[]): boolean;
  setProfileName(senderJid: string, name: string): boolean;
  updateActiveGroups(senderJid: string, groupJid: string): boolean;
  getOptedInProfiles(): MemberProfile[];
  deleteProfileData(senderJid: string): boolean;

  // Context
  storeMessage(chatJid: string, sender: string, text: string, timestamp: number): void;
  getMessages(chatJid: string, limit?: number): DbMessage[];

  // Moderation
  logModeration(entry: Omit<ModerationEntry, 'id'>): void;
  getStrikeCount(chatJid: string, sender: string, windowDays?: number): number;
  getRepeatOffenders(chatJid: string, threshold?: number, windowDays?: number): StrikeSummary[];

  // Daily stats archive
  saveDailyStats(date: string, json: string): void;

  // Feedback
  submitFeedback(chatJid: string, senderJid: string, text: string): FeedbackEntry;
  getOpenFeedback(): FeedbackEntry[];
  getRecentFeedback(limit?: number): FeedbackEntry[];
  getFeedbackById(id: number): FeedbackEntry | undefined;
  setFeedbackStatus(id: number, status: 'open' | 'accepted' | 'rejected' | 'done'): boolean;
  upvoteFeedback(id: number, senderJid: string): boolean;
  linkFeedbackToGitHubIssue(id: number, issueNumber: number, issueUrl: string): boolean;

  // Memory
  addMemory(fact: string, category?: string, source?: string): MemoryEntry;
  getAllMemories(): MemoryEntry[];
  deleteMemory(id: number): boolean;
  searchMemory(keyword: string, limit?: number): MemoryEntry[];
  formatMemoriesForPrompt(): string;

  // Lifecycle
  closeDb(): void;
}
