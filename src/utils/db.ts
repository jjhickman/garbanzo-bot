/**
 * Database API — runtime-selected backend.
 */

import { config } from './config.js';
import { logger } from '../middleware/logger.js';
import type { DbBackend } from './db-backend.js';
import type { AdminAuditLogInput, LocalMemoryEntry, MemoryEntry, SharedMemoryEntry } from './db-types.js';
import {
  deleteFact,
  deleteSharedFact,
  indexFact,
  indexSharedFact,
} from './vector-memory.js';
import { truncate } from './formatting.js';

export type {
  Availability,
  AvailabilityResponse,
  AdminAuditLogEntry,
  AdminAuditLogInput,
  BackfillSession,
  BackupIntegrityStatus,
  BridgeBufferEntry,
  BridgeOutboxCounts,
  BridgeOutboxEntry,
  DailyGroupActivity,
  DbMessage,
  EventReminder,
  EventReminderStatus,
  FeedbackEntry,
  MaintenanceStats,
  MemberProfile,
  MemoryEntry,
  ModerationEntry,
  NativeEvent,
  NativeEventStatus,
  NewEventReminder,
  NewNativeEvent,
  Rehearsal,
  RehearsalStatus,
  SectionKind,
  Setlist,
  SetlistEntry,
  SetlistSong,
  Song,
  SongIdea,
  SongSection,
  SongStatus,
  StrikeSummary,
  SessionSummaryHit,
  WhatsAppOutboundJob,
  WhatsAppOutboundStatus,
  WhatsAppRiskLevel,
  WhatsAppSafetyMetrics,
  WhatsAppSafetyState,
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
export const searchRelevantSessionSummaries = backend.searchRelevantSessionSummaries;
export const listMessageChatJids = backend.listMessageChatJids;
export const listSummarizedSessions = backend.listSummarizedSessions;

// Moderation
export const logModeration = backend.logModeration;
export const getStrikeCount = backend.getStrikeCount;
export const getRepeatOffenders = backend.getRepeatOffenders;

// Daily stats
export const saveDailyStats = backend.saveDailyStats;
export const getDailyGroupActivity = backend.getDailyGroupActivity;
export const loadDailyStatsRange = backend.loadDailyStatsRange;

// Event reminders
export const addEventReminder = backend.addEventReminder;
export const listPendingEventReminders = backend.listPendingEventReminders;
export const listUpcomingEventReminders = backend.listUpcomingEventReminders;
export const markEventReminderSent = backend.markEventReminderSent;
export const cancelEventReminder = backend.cancelEventReminder;
export const rescheduleEventReminder = backend.rescheduleEventReminder;
export const renameEventReminder = backend.renameEventReminder;

// Native platform events (Discord scheduled events / WhatsApp event messages)
export const addNativeEvent = backend.addNativeEvent;
export const getNativeEventById = backend.getNativeEventById;
export const listUpcomingNativeEvents = backend.listUpcomingNativeEvents;
export const updateNativeEvent = backend.updateNativeEvent;

// WhatsApp safety
export const createWhatsAppOutboundJob = backend.createWhatsAppOutboundJob;
export const updateWhatsAppOutboundJob = backend.updateWhatsAppOutboundJob;
export const getWhatsAppOutboundJob = backend.getWhatsAppOutboundJob;
export const listWhatsAppHeldJobs = backend.listWhatsAppHeldJobs;
export const recoverWhatsAppPendingJobs = backend.recoverWhatsAppPendingJobs;
export const countWhatsAppSentSince = backend.countWhatsAppSentSince;
export const getWhatsAppSafetyState = backend.getWhatsAppSafetyState;
export const setWhatsAppSafetyState = backend.setWhatsAppSafetyState;
export const getWhatsAppSafetyMetrics = backend.getWhatsAppSafetyMetrics;

// Bridge durable outbox and receiver deduplication
export const enqueueBridgeOutbox = backend.enqueueBridgeOutbox;
export const claimDueBridgeOutbox = backend.claimDueBridgeOutbox;
export const markBridgeOutboxSent = backend.markBridgeOutboxSent;
export const markBridgeOutboxDead = backend.markBridgeOutboxDead;
export const bumpBridgeOutboxAttempt = backend.bumpBridgeOutboxAttempt;
export const deferBridgeOutbox = backend.deferBridgeOutbox;
export const bridgeSeenInsert = backend.bridgeSeenInsert;
export const bridgeSeenDelete = backend.bridgeSeenDelete;
export const bridgeOutboxCounts = backend.bridgeOutboxCounts;

// Bridge summary buffer (rate-safe WhatsApp relay mode, Task 7)
export const appendBridgeBuffer = backend.appendBridgeBuffer;
export const takeBridgeBuffer = backend.takeBridgeBuffer;
export const restoreBridgeBuffer = backend.restoreBridgeBuffer;
export const bridgeBufferDepths = backend.bridgeBufferDepths;

// Feedback
export const submitFeedback = backend.submitFeedback;
export const getOpenFeedback = backend.getOpenFeedback;
export const getRecentFeedback = backend.getRecentFeedback;
export const getFeedbackById = backend.getFeedbackById;
export const setFeedbackStatus = backend.setFeedbackStatus;
export const upvoteFeedback = backend.upvoteFeedback;
export const linkFeedbackToGitHubIssue = backend.linkFeedbackToGitHubIssue;

// Memory
export async function addMemory(
  fact: string,
  category?: string,
  source?: string,
): Promise<LocalMemoryEntry> {
  const entry = await backend.addMemory(fact, category, source);
  void indexFact({
    refId: String(entry.id),
    text: entry.fact,
    category: entry.category,
    createdAt: entry.created_at,
  }).catch((err) => logger.warn({ err }, 'memory fact vector index failed'));
  return entry;
}
export const getAllMemories = backend.getAllMemories;
export async function deleteMemory(id: number): Promise<boolean> {
  const deleted = await backend.deleteMemory(id);
  void deleteFact(String(id))
    .catch((err) => logger.warn({ err }, 'memory fact vector delete failed'));
  return deleted;
}
export async function deleteMemoryWithAudit(id: number, audit: AdminAuditLogInput): Promise<boolean> {
  const deleted = await backend.deleteMemoryWithAudit(id, audit);
  if (deleted) {
    void deleteFact(String(id))
      .catch((err) => logger.warn({ err }, 'memory fact vector delete failed'));
  }
  return deleted;
}
export async function searchMemory(keyword: string, limit = 10): Promise<MemoryEntry[]> {
  const { searchFacts } = await import('./vector-memory.js');
  const hits = await searchFacts(keyword, limit);
  let localResults: MemoryEntry[];
  if (hits.length > 0) {
    // Vector payloads don't carry source; hydrate it from the relational
    // source of record so provenance tags ((auto)/(ai)) stay truthful.
    const sourceById = new Map(
      (await backend.getAllMemories()).map((m) => [m.id, m.source]),
    );
    localResults = hits.map((h) => {
      const id = Number(h.payload.refId);
      return {
        id,
        fact: h.payload.text,
        category: String(h.payload.extra?.category ?? 'general'),
        source: sourceById.get(id) ?? 'auto',
        created_at: h.payload.createdAt,
      };
    });
  } else {
    localResults = await backend.searchMemory(keyword, limit);
  }

  if (!config.SHARED_MEMORY_ENABLED) return localResults;

  const { searchSharedFacts } = await import('./vector-memory.js');
  const sharedHits = await searchSharedFacts(keyword, 4);
  const sharedResults: SharedMemoryEntry[] = sharedHits.map((hit) => ({
    shared: true,
    originInstance: hit.originInstance,
    fact: hit.text,
    category: hit.category,
    source: 'shared',
    created_at: 0,
  }));

  return [...localResults, ...sharedResults];
}
export const formatMemoriesForPrompt = backend.formatMemoriesForPrompt;
export const addAdminAuditLog = backend.addAdminAuditLog;
export const getAdminAuditLog = backend.getAdminAuditLog;

export type ShareMemoryResult = 'shared' | 'not-found' | 'failed';

/** Share one local memory through the same path used by owner commands and the admin API. */
export async function shareMemory(id: number): Promise<ShareMemoryResult> {
  const memory = (await backend.getAllMemories()).find((entry) => entry.id === id);
  if (!memory) return 'not-found';
  const shared = await indexSharedFact({
    localId: id,
    text: memory.fact,
    category: memory.category,
  });
  return shared ? 'shared' : 'failed';
}

/** Unshare one local memory through the same path used by owner commands and the admin API. */
export async function unshareMemory(id: number): Promise<boolean> {
  return deleteSharedFact(id);
}

const PROMPT_MEMORY_MAX_CHARS = 4000;

export async function formatMemoriesForPromptWithShared(userMessage?: string): Promise<string> {
  const localBlock = await backend.formatMemoriesForPrompt();
  const query = userMessage?.trim();
  if (!config.SHARED_MEMORY_ENABLED || !query) return localBlock;

  const { searchSharedFacts } = await import('./vector-memory.js');
  const sharedHits = await searchSharedFacts(query, 3);
  if (sharedHits.length === 0) return localBlock;

  const sharedLines = [
    'Shared community knowledge (relevant facts from other instances):',
    ...sharedHits.map((hit) => `  - [shared from ${hit.originInstance}] ${hit.text}`),
  ];
  const sharedBlock = sharedLines.join('\n');
  const combined = localBlock ? `${localBlock}\n${sharedBlock}` : sharedBlock;
  return truncate(combined, PROMPT_MEMORY_MAX_CHARS);
}

// Songs (shared band memory)
export const addSong = backend.addSong;
export const getSongById = backend.getSongById;
export const getSongByTitle = backend.getSongByTitle;
export const listSongs = backend.listSongs;
export const updateSong = backend.updateSong;
export const deleteSong = backend.deleteSong;

// Song ideas (shared band songwriting scratchpad)
export const addSongIdea = backend.addSongIdea;
export const getSongIdeaById = backend.getSongIdeaById;
export const listSongIdeas = backend.listSongIdeas;
export const linkSongIdeaToSong = backend.linkSongIdeaToSong;
export const deleteSongIdea = backend.deleteSongIdea;

// Song sections (per-song structure: intro/verse/chorus/...)
export const addSongSection = backend.addSongSection;
export const getSongSections = backend.getSongSections;
export const updateSongSection = backend.updateSongSection;
export const moveSongSection = backend.moveSongSection;
export const removeSongSection = backend.removeSongSection;

// Rehearsals (shared band practice memory)
export const addRehearsal = backend.addRehearsal;
export const getRehearsalById = backend.getRehearsalById;
export const listUpcomingRehearsals = backend.listUpcomingRehearsals;
export const getNextRehearsal = backend.getNextRehearsal;
export const updateRehearsal = backend.updateRehearsal;
export const cancelRehearsal = backend.cancelRehearsal;
export const listRehearsalsNeedingReminder = backend.listRehearsalsNeedingReminder;
export const markRehearsalReminderSent = backend.markRehearsalReminderSent;

// Availability (per-rehearsal band member RSVPs)
export const setAvailability = backend.setAvailability;
export const listAvailability = backend.listAvailability;

// Setlists (ordered song lists referencing shared band songs)
export const addSetlist = backend.addSetlist;
export const getSetlistByName = backend.getSetlistByName;
export const listSetlists = backend.listSetlists;
export const deleteSetlist = backend.deleteSetlist;
export const addSongToSetlist = backend.addSongToSetlist;
export const removeSongFromSetlist = backend.removeSongFromSetlist;
export const moveSetlistSong = backend.moveSetlistSong;
export const getSetlistSongs = backend.getSetlistSongs;

// Lifecycle
export const closeDb = backend.closeDb;
