/**
 * Member profile queries — CRUD operations on the member_profiles table.
 *
 * Profiles track opted-in members' interests, active groups, and event
 * attendance. Created passively via touchProfile() on every message.
 */

import { db } from './db-schema.js';

// ── Prepared statements ─────────────────────────────────────────────

const upsertProfile = db.prepare(`
  INSERT INTO member_profiles (jid, first_seen, last_seen)
  VALUES (?, ?, ?)
  ON CONFLICT(jid) DO UPDATE SET last_seen = excluded.last_seen
`);

const selectProfile = db.prepare(`
  SELECT * FROM member_profiles WHERE jid = ?
`);

const updateProfileInterests = db.prepare(`
  UPDATE member_profiles SET interests = ?, opted_in = 1 WHERE jid = ?
`);

const updateProfileName = db.prepare(`
  UPDATE member_profiles SET name = ? WHERE jid = ?
`);

const updateProfileGroups = db.prepare(`
  UPDATE member_profiles SET groups_active = ? WHERE jid = ?
`);

const incrementEventCount = db.prepare(`
  UPDATE member_profiles SET event_count = event_count + 1 WHERE jid = ?
`);

const selectOptedInProfiles = db.prepare(`
  SELECT * FROM member_profiles WHERE opted_in = 1
`);

const deleteProfile = db.prepare(`
  DELETE FROM member_profiles WHERE jid = ?
`);

// ── Types ───────────────────────────────────────────────────────────

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

// ── Public API ──────────────────────────────────────────────────────

/** Ensure a profile row exists for a member (called passively on every message) */
export function touchProfile(senderJid: string): void {
  const bare = senderJid.split('@')[0].split(':')[0];
  const now = Math.floor(Date.now() / 1000);
  upsertProfile.run(bare, now, now);
}

/** Get a member's profile, or undefined if not found */
export function getProfile(senderJid: string): MemberProfile | undefined {
  const bare = senderJid.split('@')[0].split(':')[0];
  return selectProfile.get(bare) as MemberProfile | undefined;
}

/** Set a member's interests (opt-in) */
export function setProfileInterests(senderJid: string, interests: string[]): void {
  const bare = senderJid.split('@')[0].split(':')[0];
  updateProfileInterests.run(JSON.stringify(interests), bare);
}

/** Set a member's display name */
export function setProfileName(senderJid: string, name: string): void {
  const bare = senderJid.split('@')[0].split(':')[0];
  updateProfileName.run(name, bare);
}

/** Update which groups a member is active in */
export function updateActiveGroups(senderJid: string, groupJid: string): void {
  const bare = senderJid.split('@')[0].split(':')[0];
  const profile = selectProfile.get(bare) as MemberProfile | undefined;
  if (!profile) return;

  const groups = JSON.parse(profile.groups_active) as string[];
  if (!groups.includes(groupJid)) {
    groups.push(groupJid);
    updateProfileGroups.run(JSON.stringify(groups), bare);
  }
}

/** Increment a member's event attendance count */
export function recordEventAttendance(senderJid: string): void {
  const bare = senderJid.split('@')[0].split(':')[0];
  incrementEventCount.run(bare);
}

/** Get all opted-in profiles */
export function getOptedInProfiles(): MemberProfile[] {
  return selectOptedInProfiles.all() as MemberProfile[];
}

/** Delete a member's profile (opt-out) */
export function deleteProfileData(senderJid: string): void {
  const bare = senderJid.split('@')[0].split(':')[0];
  deleteProfile.run(bare);
}
