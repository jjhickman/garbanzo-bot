/**
 * Database API — runtime-selected backend.
 */

import { config } from './config.js';
import type { DbBackend } from './db-backend.js';

export type {
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

const backend: DbBackend = await (async () => {
  if (config.DB_DIALECT === 'postgres') {
    const pg = await import('./db-postgres.js');
    return pg.createPostgresBackend();
  }

  const sqlite = await import('./db-sqlite.js');
  return sqlite.createSqliteBackend();
})();

// Profiles
export const touchProfile = backend.touchProfile;
export const getProfile = backend.getProfile;
export const setProfileInterests = backend.setProfileInterests;
export const setProfileName = backend.setProfileName;
export const updateActiveGroups = backend.updateActiveGroups;
export const getOptedInProfiles = backend.getOptedInProfiles;
export const deleteProfileData = backend.deleteProfileData;

// Maintenance and backups
export const backupDatabase = backend.backupDatabase;
export const runMaintenance = backend.runMaintenance;
export const verifyLatestBackupIntegrity = backend.verifyLatestBackupIntegrity;
export const scheduleMaintenance = backend.scheduleMaintenance;
export const stopMaintenance = backend.stopMaintenance;

// Context
export const storeMessage = backend.storeMessage;
export const getMessages = backend.getMessages;
export const searchRelevantMessages = backend.searchRelevantMessages;

// Moderation
export const logModeration = backend.logModeration;
export const getStrikeCount = backend.getStrikeCount;
export const getRepeatOffenders = backend.getRepeatOffenders;

// Daily stats
export const saveDailyStats = backend.saveDailyStats;
export const getDailyGroupActivity = backend.getDailyGroupActivity;

// Feedback
export const submitFeedback = backend.submitFeedback;
export const getOpenFeedback = backend.getOpenFeedback;
export const getRecentFeedback = backend.getRecentFeedback;
export const getFeedbackById = backend.getFeedbackById;
export const setFeedbackStatus = backend.setFeedbackStatus;
export const upvoteFeedback = backend.upvoteFeedback;
export const linkFeedbackToGitHubIssue = backend.linkFeedbackToGitHubIssue;

// Memory
export const addMemory = backend.addMemory;
export const getAllMemories = backend.getAllMemories;
export const deleteMemory = backend.deleteMemory;
export const searchMemory = backend.searchMemory;
export const formatMemoriesForPrompt = backend.formatMemoriesForPrompt;

// Lifecycle
export const closeDb = backend.closeDb;
