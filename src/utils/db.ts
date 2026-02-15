/**
 * Database API — runtime-selected backend.
 *
 * Today, Garbanzo ships with SQLite only.
 * This module is written as a thin wrapper so we can add a Postgres backend
 * later without rewriting all feature imports.
 */

import { config } from './config.js';

export type {
  DbMessage,
  ModerationEntry,
  StrikeSummary,
  FeedbackEntry,
  MemoryEntry,
} from './db-sqlite.js';

export type { MemberProfile } from './db-profiles.js';
export type { BackupIntegrityStatus } from './db-maintenance.js';

if (config.DB_DIALECT !== 'sqlite') {
  throw new Error(
    `DB_DIALECT=${config.DB_DIALECT} is not implemented yet. Use DB_DIALECT=sqlite for now.`,
  );
}

const sqlite = await import('./db-sqlite.js');

// Re-export the current public API by delegating to the sqlite backend.
// Keep exports explicit so future backends can implement the same surface.

export const touchProfile = sqlite.touchProfile;
export const getProfile = sqlite.getProfile;
export const setProfileInterests = sqlite.setProfileInterests;
export const setProfileName = sqlite.setProfileName;
export const updateActiveGroups = sqlite.updateActiveGroups;
export const getOptedInProfiles = sqlite.getOptedInProfiles;
export const deleteProfileData = sqlite.deleteProfileData;

export const backupDatabase = sqlite.backupDatabase;
export const runMaintenance = sqlite.runMaintenance;
export const verifyLatestBackupIntegrity = sqlite.verifyLatestBackupIntegrity;
export const scheduleMaintenance = sqlite.scheduleMaintenance;
export const stopMaintenance = sqlite.stopMaintenance;

export const storeMessage = sqlite.storeMessage;
export const getMessages = sqlite.getMessages;

export const logModeration = sqlite.logModeration;
export const getStrikeCount = sqlite.getStrikeCount;
export const getRepeatOffenders = sqlite.getRepeatOffenders;

export const saveDailyStats = sqlite.saveDailyStats;

export const submitFeedback = sqlite.submitFeedback;
export const getOpenFeedback = sqlite.getOpenFeedback;
export const getRecentFeedback = sqlite.getRecentFeedback;
export const getFeedbackById = sqlite.getFeedbackById;
export const setFeedbackStatus = sqlite.setFeedbackStatus;
export const upvoteFeedback = sqlite.upvoteFeedback;
export const linkFeedbackToGitHubIssue = sqlite.linkFeedbackToGitHubIssue;

export const addMemory = sqlite.addMemory;
export const getAllMemories = sqlite.getAllMemories;
export const deleteMemory = sqlite.deleteMemory;
export const searchMemory = sqlite.searchMemory;
export const formatMemoriesForPrompt = sqlite.formatMemoriesForPrompt;

export const closeDb = sqlite.closeDb;
