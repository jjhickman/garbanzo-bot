/**
 * Release notes — owner command to broadcast "what's new" to groups.
 *
 * Usage (owner DM only):
 *   !release <message>         — send release notes to all enabled groups
 *   !release general <message> — send to a specific group only
 *
 * The message is wrapped in a formatted header so members know it's
 * an official update from the bot operator.
 */

import type { WASocket } from '@whiskeysockets/baileys';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../middleware/logger.js';
import { GROUP_IDS } from '../bot/groups.js';
import { PROJECT_ROOT } from '../utils/config.js';

let cachedVersion: string | null = null;
let cachedChangelogSnippet: string | null = null;

function getAppVersion(): string {
  if (cachedVersion) return cachedVersion;

  const fromEnv = process.env.GARBANZO_VERSION?.trim();
  if (fromEnv) {
    cachedVersion = fromEnv.startsWith('v') ? fromEnv : `v${fromEnv}`;
    return cachedVersion;
  }

  try {
    const pkgPath = resolve(PROJECT_ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    const version = pkg.version?.trim();
    if (version) {
      cachedVersion = version.startsWith('v') ? version : `v${version}`;
      return cachedVersion;
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve package version for release notes');
  }

  cachedVersion = 'v0.0.0';
  return cachedVersion;
}

function getChangelogSnippet(maxLines: number = 12): string {
  if (cachedChangelogSnippet) return cachedChangelogSnippet;

  try {
    const changelogPath = resolve(PROJECT_ROOT, 'CHANGELOG.md');
    const lines = readFileSync(changelogPath, 'utf-8').split('\n');
    const sectionHeaders: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('## [')) sectionHeaders.push(i);
    }

    if (sectionHeaders.length === 0) {
      cachedChangelogSnippet = 'Changelog section headers not found.';
      return cachedChangelogSnippet;
    }

    const unreleasedHeader = sectionHeaders.find((idx) => lines[idx].startsWith('## [Unreleased]'));
    const startIdx = unreleasedHeader ?? sectionHeaders[0];
    const nextHeader = sectionHeaders.find((idx) => idx > startIdx) ?? lines.length;

    const sectionTitle = lines[startIdx].replace(/^##\s+/, '').trim();
    const rawSection = lines.slice(startIdx + 1, nextHeader)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);

    const snippetLines = rawSection.slice(0, maxLines);
    if (rawSection.length > maxLines) {
      snippetLines.push('...');
    }

    cachedChangelogSnippet = [
      `🧾 *Changelog ${sectionTitle}*`,
      '',
      ...snippetLines,
    ].join('\n');
    return cachedChangelogSnippet;
  } catch (err) {
    logger.error({ err }, 'Failed to load changelog snippet for release notes');
    return '❌ Unable to load changelog snippet.';
  }
}

/**
 * Parse and send release notes.
 * Returns a confirmation message for the owner DM.
 */
export async function handleRelease(
  args: string,
  sock: WASocket,
): Promise<string> {
  if (!args.trim()) {
    return [
      '📋 *Release Notes*',
      '',
      'Usage:',
      '  !release <message> — broadcast to all groups',
      '  !release <group> <message> — send to one group',
      '  !release changelog — broadcast latest changelog section',
      '  !release <group> changelog — send changelog to one group',
      `  (header auto-includes version ${getAppVersion()})`,
      '',
      'Groups: ' + Object.values(GROUP_IDS).map((g) => g.name.toLowerCase()).join(', '),
    ].join('\n');
  }

  // Check if first word matches a group name
  const firstWord = args.trim().split(/\s+/)[0].toLowerCase();
  const targetGroup = Object.entries(GROUP_IDS).find(
    ([, g]) => g.name.toLowerCase() === firstWord && g.enabled,
  );

  let targetJids: string[];
  let message: string;

  if (targetGroup) {
    targetJids = [targetGroup[0]];
    message = args.trim().slice(firstWord.length).trim();
    if (!message) {
      return '❌ No message provided after group name.';
    }
  } else {
    targetJids = Object.entries(GROUP_IDS)
      .filter(([, g]) => g.enabled)
      .map(([jid]) => jid);
    message = args.trim();
  }

  const changelogMatch = message.match(/^changelog(?:\s+(\d+))?$/i);
  const payload = changelogMatch
    ? getChangelogSnippet(Number.parseInt(changelogMatch[1] ?? '12', 10) || 12)
    : message;

  const formatted = [
    '📋 *What\'s New with Garbanzo* 🫘',
    `*Version:* ${getAppVersion()}`,
    '',
    payload,
  ].join('\n');

  let sent = 0;
  let failed = 0;

  for (const jid of targetJids) {
    try {
      await sock.sendMessage(jid, { text: formatted });
      sent++;
    } catch (err) {
      logger.error({ err, jid }, 'Failed to send release notes');
      failed++;
    }
  }

  const groupNames = targetJids.map((jid) => GROUP_IDS[jid]?.name ?? jid);
  return `✅ Release notes sent to ${sent} group${sent !== 1 ? 's' : ''}${failed > 0 ? ` (${failed} failed)` : ''}: ${groupNames.join(', ')}`;
}
