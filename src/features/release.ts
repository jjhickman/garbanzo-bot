/**
 * Release notes helper for owner DMs.
 *
 * Primary goal: keep member-facing updates clear and relevant.
 * Technical/internal updates should stay in owner channels unless force-sent.
 *
 * Usage (owner DM):
 *   !release rules
 *   !release preview <notes>
 *   !release send <notes>
 *   !release send <group> <notes>
 *   !release send changelog [maxLines]
 *   !release send --force <notes>
 *   !release internal <notes>
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../middleware/logger.js';
import { GROUP_IDS } from '../core/groups-config.js';
import { PROJECT_ROOT } from '../utils/config.js';

let cachedVersion: string | null = null;
let cachedChangelogSnippet: string | null = null;

const INTERNAL_HINTS: RegExp[] = [
  /\brefactor\b/i,
  /\bci\b/i,
  /\bpipeline\b/i,
  /\bworkflow\b/i,
  /\btest(?:s|ing)?\b/i,
  /\bdependency|dependencies|deps\b/i,
  /\blint\b/i,
  /\btypescript|type(?:s)?\b/i,
  /\bdocs?|readme\b/i,
  /\bdocker|compose\b/i,
  /\bchore\b/i,
];

const MEMBER_IMPACT_HINTS: RegExp[] = [
  /\bnew\b/i,
  /\byou can\b/i,
  /\bfix(?:ed)?\b/i,
  /\bimprov(?:e|ed|ement)\b/i,
  /\bfaster\b/i,
  /\bavailable\b/i,
  /\bcommand\b/i,
  /\bfeature\b/i,
  /\boutage|incident|maintenance\b/i,
  /\baction required\b/i,
  /\bmembers?\b/i,
  /\bgroup\b/i,
];

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

function getChangelogSnippet(maxLines: number = 8): string {
  if (cachedChangelogSnippet && maxLines === 8) return cachedChangelogSnippet;

  try {
    const changelogPath = resolve(PROJECT_ROOT, 'CHANGELOG.md');
    const lines = readFileSync(changelogPath, 'utf-8').split('\n');
    const sectionHeaders: number[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startsWith('## [')) sectionHeaders.push(i);
    }

    if (sectionHeaders.length === 0) {
      return 'Changelog section headers not found.';
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

    const snippet = [
      `🧾 *Changelog ${sectionTitle}*`,
      '',
      ...snippetLines,
    ].join('\n');

    if (maxLines === 8) cachedChangelogSnippet = snippet;
    return snippet;
  } catch (err) {
    logger.error({ err }, 'Failed to load changelog snippet for release notes');
    return '❌ Unable to load changelog snippet.';
  }
}

function getGroupNames(): string {
  return Object.values(GROUP_IDS)
    .filter((group) => group.enabled)
    .map((group) => group.name.toLowerCase())
    .join(', ');
}

function releaseRulesText(): string {
  return [
    '📣 *Member Release Update Rules*',
    '',
    'Send to members only when the change affects their chat experience:',
    '• New member-visible feature or command',
    '• Bug fix members can notice',
    '• Outage/maintenance/update requiring member action',
    '',
    'Do not broadcast internal-only updates:',
    '• CI/workflow/test/dependency/refactor/docs-only changes',
    '',
    'Tips:',
    '• Keep messages short (8 lines max)',
    '• Explain impact in plain language',
    '• Use `!release preview ...` before sending',
    '• Use `!release internal ...` for operator-only notes',
  ].join('\n');
}

function formatReleaseMessage(payload: string): string {
  return [
    '📋 *What\'s New with Garbanzo* 🫘',
    `*Version:* ${getAppVersion()}`,
    '',
    payload,
  ].join('\n');
}

function formatInternalNote(payload: string): string {
  return [
    '🛠️ *Operator Update (Not Broadcast)*',
    `*Version:* ${getAppVersion()}`,
    '',
    payload,
  ].join('\n');
}

function parseMode(args: string): {
  mode: 'send' | 'preview' | 'internal' | 'rules';
  rest: string;
  implicitPreview: boolean;
} {
  const trimmed = args.trim();
  const modeMatch = trimmed.match(/^(send|preview|internal|rules)\b/i);

  if (!modeMatch) {
    return {
      mode: 'preview',
      rest: trimmed,
      implicitPreview: true,
    };
  }

  return {
    mode: modeMatch[1].toLowerCase() as 'send' | 'preview' | 'internal' | 'rules',
    rest: trimmed.slice(modeMatch[0].length).trim(),
    implicitPreview: false,
  };
}

function parseTargetAndMessage(input: string): {
  targetJids: string[];
  message: string;
} {
  const firstWord = input.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const targetGroup = Object.entries(GROUP_IDS).find(
    ([, group]) => group.enabled && group.name.toLowerCase() === firstWord,
  );

  if (targetGroup) {
    const message = input.trim().slice(firstWord.length).trim();
    return {
      targetJids: [targetGroup[0]],
      message,
    };
  }

  return {
    targetJids: Object.entries(GROUP_IDS)
      .filter(([, group]) => group.enabled)
      .map(([jid]) => jid),
    message: input.trim(),
  };
}

function buildPayload(message: string): { payload: string; isChangelog: boolean } {
  const changelogMatch = message.match(/^changelog(?:\s+(\d+))?$/i);
  if (!changelogMatch) {
    return { payload: message, isChangelog: false };
  }

  const requestedLines = Number.parseInt(changelogMatch[1] ?? '8', 10);
  const maxLines = Number.isNaN(requestedLines)
    ? 8
    : Math.max(3, Math.min(15, requestedLines));

  return {
    payload: getChangelogSnippet(maxLines),
    isChangelog: true,
  };
}

function lintMemberFacingPayload(payload: string): string[] {
  const issues: string[] = [];
  const normalized = payload.trim();
  const lineCount = normalized.split('\n').map((line) => line.trim()).filter(Boolean).length;

  const internalHits = INTERNAL_HINTS.filter((pattern) => pattern.test(normalized)).length;
  const impactHits = MEMBER_IMPACT_HINTS.filter((pattern) => pattern.test(normalized)).length;

  if (lineCount > 8) {
    issues.push('Keep member updates to 8 lines or fewer for readability.');
  }

  if (impactHits === 0) {
    issues.push('Add member-facing impact language (what changed for members or required action).');
  }

  if (internalHits >= 2 && impactHits === 0) {
    issues.push('This reads like an internal/operator change (CI, dependencies, refactor, docs).');
  }

  return issues;
}

/**
 * Parse and route owner release notes command.
 * Returns a confirmation/preview message for the owner DM.
 */
export async function handleRelease(
  args: string,
  sendText: (chatId: string, text: string) => Promise<void>,
): Promise<string> {
  if (!args.trim()) {
    return [
      '📋 *Release Notes*',
      '',
      'Usage:',
      '  !release rules',
      '  !release preview <message> — format + lint only, no broadcast',
      '  !release send <message> — broadcast to all enabled groups',
      '  !release send <group> <message> — broadcast to one group',
      '  !release send changelog [lines] — send latest changelog snippet',
      '  !release send --force <message> — bypass member-facing lint checks',
      '  !release internal <message> — keep update operator-only (no broadcast)',
      `  (header auto-includes version ${getAppVersion()})`,
      '',
      'Enabled groups: ' + getGroupNames(),
    ].join('\n');
  }

  const { mode, rest, implicitPreview } = parseMode(args);

  if (mode === 'rules') {
    return releaseRulesText();
  }

  if (!rest) {
    return mode === 'internal'
      ? '❌ No internal update provided. Example: `!release internal Rotated API key and updated host firewall.`'
      : '❌ No release message provided.';
  }

  let force = false;
  let restWithoutForce = rest;
  if (mode === 'send') {
    restWithoutForce = restWithoutForce.replace(/^--force\b\s*/i, (matched) => {
      force = Boolean(matched);
      return '';
    }).trim();
  }

  if (mode === 'internal') {
    const { payload } = buildPayload(restWithoutForce);
    return [
      formatInternalNote(payload),
      '',
      '✅ Internal note saved to DM output only. No group broadcast was sent.',
    ].join('\n');
  }

  const { targetJids, message } = parseTargetAndMessage(restWithoutForce);
  if (!message) {
    return '❌ No message provided after target group.';
  }

  if (targetJids.length === 0) {
    return '⚠️ No enabled groups found to send release notes.';
  }

  const { payload, isChangelog } = buildPayload(message);
  const formatted = formatReleaseMessage(payload);
  const lintIssues = isChangelog ? [] : lintMemberFacingPayload(payload);

  if (mode === 'preview') {
    const lines: string[] = [formatted, '', '---', ''];

    if (lintIssues.length === 0) {
      lines.push('✅ Lint check passed.');
    } else {
      lines.push('⚠️ Lint check warnings:');
      for (const issue of lintIssues) {
        lines.push(`- ${issue}`);
      }
    }

    if (implicitPreview) {
      lines.push('');
      lines.push('No messages were sent.');
      lines.push('Use `!release send ...` when this is ready for members.');
    }

    return lines.join('\n');
  }

  if (!force && lintIssues.length > 0) {
    return [
      '❌ Release note not sent.',
      '',
      'Why it was blocked:',
      ...lintIssues.map((issue) => `- ${issue}`),
      '',
      'Try one of:',
      '- Rewrite as member-facing impact and send again',
      '- Use `!release preview ...` to refine the message first',
      '- Use `!release internal ...` for operator-only updates',
      '- Use `!release send --force ...` only if this truly belongs in member chats',
    ].join('\n');
  }

  let sent = 0;
  let failed = 0;

  for (const jid of targetJids) {
    try {
      await sendText(jid, formatted);
      sent += 1;
    } catch (err) {
      failed += 1;
      logger.error({ err, jid }, 'Failed to send release notes');
    }
  }

  const groupNames = targetJids.map((jid) => GROUP_IDS[jid]?.name ?? jid);
  const forcedSuffix = force ? ' (force override)' : '';
  return `✅ Release notes sent to ${sent} group${sent !== 1 ? 's' : ''}${failed > 0 ? ` (${failed} failed)` : ''}${forcedSuffix}: ${groupNames.join(', ')}`;
}
