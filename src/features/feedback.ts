import { bold } from '../utils/formatting.js';
import { logger } from '../middleware/logger.js';
import { getGroupName } from '../bot/groups.js';
import { config } from '../utils/config.js';
import {
  submitFeedback,
  getOpenFeedback,
  getRecentFeedback,
  getFeedbackById,
  setFeedbackStatus,
  upvoteFeedback,
  linkFeedbackToGitHubIssue,
  type FeedbackEntry,
} from '../utils/db.js';

/**
 * Feedback feature — members submit feature suggestions and bug reports
 * via bang commands. Items are stored in SQLite and forwarded to the
 * owner's DM. Owner can review, accept, reject, or mark done.
 * Members can upvote existing items with !upvote <id>.
 *
 * Member commands:
 *   !suggest <description>     — submit a feature suggestion
 *   !bug <description>         — report a bug
 *   !upvote <id>               — upvote an existing item
 *
 * Owner commands (DM only):
 *   !feedback                  — list all open items
 *   !feedback all              — list recent items (any status)
 *   !feedback accept <id>      — accept an item
 *   !feedback reject <id>      — reject an item
 *   !feedback done <id>        — mark as completed
 */

// ── Member commands ─────────────────────────────────────────────────

interface FeedbackResult {
  /** Response text to send back to the user in the group */
  response: string;
  /** Alert to forward to the owner via DM (null if no forwarding needed) */
  ownerAlert: string | null;
}

/**
 * Handle a !suggest or !bug command from a member.
 * Returns the response to send and an optional owner DM alert.
 */
export function handleFeedbackSubmit(
  type: 'suggestion' | 'bug',
  description: string,
  senderJid: string,
  groupJid: string | null,
): FeedbackResult {
  const trimmed = description.trim();
  if (!trimmed) {
    const example = type === 'suggestion'
      ? '!suggest Add a music recommendation feature'
      : '!bug Bot responded to a message that wasn\'t an @mention';
    return {
      response: `Please include a description.\nExample: ${example}`,
      ownerAlert: null,
    };
  }

  if (trimmed.length < 10) {
    return {
      response: 'Please provide a bit more detail so I can understand what you mean.',
      ownerAlert: null,
    };
  }

  const entry = submitFeedback(type, senderJid, groupJid, trimmed);
  const label = type === 'suggestion' ? 'Feature suggestion' : 'Bug report';
  const emoji = type === 'suggestion' ? '💡' : '🐛';
  const groupName = groupJid ? getGroupName(groupJid) : 'DM';

  logger.info({
    feedbackId: entry.id,
    type,
    sender: entry.sender,
    group: groupName,
  }, 'Feedback submitted');

  const response = [
    `${emoji} ${label} received! (ID: #${entry.id})`,
    '',
    `"${truncateText(trimmed, 150)}"`,
    '',
    `I've forwarded this to Josh. Members can upvote with: !upvote ${entry.id}`,
  ].join('\n');

  const ownerAlert = [
    `${emoji} ${bold(`New ${label.toLowerCase()}`)} #${entry.id}`,
    '',
    `${bold('From:')} ${entry.sender}`,
    `${bold('Group:')} ${groupName}`,
    `${bold('Description:')} ${trimmed}`,
    '',
    `Reply with: !feedback accept ${entry.id} / reject ${entry.id} / done ${entry.id}`,
    `(After accept) !feedback issue ${entry.id} to open a GitHub issue`,
  ].join('\n');

  return { response, ownerAlert };
}

/**
 * Handle !upvote <id> from a member.
 */
export function handleUpvote(
  args: string,
  senderJid: string,
): string {
  const id = parseInt(args.trim(), 10);
  if (isNaN(id)) {
    return 'Usage: !upvote <id>\nExample: !upvote 3';
  }

  const entry = getFeedbackById(id);
  if (!entry) {
    return `No feedback item found with ID #${id}.`;
  }

  if (entry.status !== 'open') {
    return `Item #${id} is already ${entry.status}.`;
  }

  const success = upvoteFeedback(id, senderJid);
  if (!success) {
    return `You've already upvoted #${id}.`;
  }

  const updated = getFeedbackById(id);
  const emoji = entry.type === 'suggestion' ? '💡' : '🐛';
  return `${emoji} Upvoted #${id}! (${updated?.upvotes ?? 1} vote${(updated?.upvotes ?? 1) !== 1 ? 's' : ''})`;
}

// ── Owner commands ──────────────────────────────────────────────────

/**
 * Handle owner !feedback commands.
 * Returns the response to send to the owner DM.
 */
export function handleFeedbackOwner(args: string): string {
  const trimmed = args.trim().toLowerCase();

  // !feedback (no args) — list open items
  if (!trimmed || trimmed === 'open') {
    return formatFeedbackList(getOpenFeedback(), 'open');
  }

  // !feedback all — list recent items regardless of status
  if (trimmed === 'all') {
    return formatFeedbackList(getRecentFeedback(25), 'all');
  }

  // !feedback accept/reject/done <id>
  const actionMatch = trimmed.match(/^(accept|reject|done)\s+(\d+)$/);
  if (actionMatch) {
    const verb = actionMatch[1];
    const statusMap: Record<string, 'accepted' | 'rejected' | 'done'> = {
      accept: 'accepted',
      reject: 'rejected',
      done: 'done',
    };
    const id = parseInt(actionMatch[2], 10);
    return handleStatusChange(id, statusMap[verb]);
  }

  return [
    `${bold('Feedback commands:')}`,
    '  !feedback — list open items',
    '  !feedback all — list all recent items',
    '  !feedback accept <id> — accept an item',
    '  !feedback reject <id> — reject an item',
    '  !feedback done <id> — mark as completed',
    '  !feedback issue <id> — create GitHub issue (accepted items only)',
  ].join('\n');
}

/**
 * Create and link a GitHub issue from an accepted feedback item.
 */
export async function createGitHubIssueFromFeedback(id: number): Promise<string> {
  const entry = getFeedbackById(id);
  if (!entry) {
    return `No feedback item found with ID #${id}.`;
  }

  if (entry.status !== 'accepted') {
    return `Item #${id} must be ${bold('accepted')} before creating a GitHub issue. Use: !feedback accept ${id}`;
  }

  if (entry.github_issue_url) {
    return `🔗 Item #${id} is already linked: ${entry.github_issue_url}`;
  }

  if (!config.GITHUB_ISSUES_TOKEN) {
    return '❌ GITHUB_ISSUES_TOKEN is not configured in .env.';
  }

  const [owner, repo] = config.GITHUB_ISSUES_REPO.split('/');
  const issueTitle = `${entry.type === 'bug' ? 'Bug' : 'Feature'}: ${truncateText(entry.text, 80)}`;
  const groupName = entry.group_jid ? getGroupName(entry.group_jid) : 'DM';

  const issueBody = [
    `Imported from Garbanzo feedback item #${entry.id}.`,
    '',
    `${bold('Type')}: ${entry.type}`,
    `${bold('From')}: ${entry.sender}`,
    `${bold('Group')}: ${groupName}`,
    `${bold('Upvotes')}: ${entry.upvotes}`,
    '',
    `${bold('Description')}:`,
    entry.text,
  ].join('\n');

  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.GITHUB_ISSUES_TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/vnd.github+json',
        'user-agent': 'garbanzo-feedback-bot',
      },
      body: JSON.stringify({
        title: issueTitle,
        body: issueBody,
        labels: ['feedback', entry.type],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({
        status: response.status,
        repo: config.GITHUB_ISSUES_REPO,
        feedbackId: id,
        errorText,
      }, 'Failed to create GitHub issue from feedback');
      return `❌ Failed to create issue: GitHub API ${response.status}`;
    }

    const data = await response.json() as { number: number; html_url: string };
    const linked = linkFeedbackToGitHubIssue(id, data.number, data.html_url);
    if (!linked) {
      return `⚠️ Created issue ${data.html_url} but failed to store local link.`;
    }

    logger.info({ feedbackId: id, issueNumber: data.number, issueUrl: data.html_url }, 'Created GitHub issue from feedback');
    return `✅ Created GitHub issue for #${id}: ${data.html_url}`;
  } catch (err) {
    logger.error({ err, feedbackId: id, repo: config.GITHUB_ISSUES_REPO }, 'Error creating GitHub issue from feedback');
    return '❌ Failed to create issue due to network/auth error.';
  }
}

// ── Formatting helpers ──────────────────────────────────────────────

function handleStatusChange(
  id: number,
  status: 'accepted' | 'rejected' | 'done',
): string {
  const entry = getFeedbackById(id);
  if (!entry) {
    return `No feedback item found with ID #${id}.`;
  }

  if (entry.status === status) {
    return `Item #${id} is already ${status}.`;
  }

  const success = setFeedbackStatus(id, status);
  if (!success) {
    return `Failed to update item #${id}.`;
  }

  const emoji = { accepted: '✅', rejected: '❌', done: '🏁' }[status];
  const label = entry.type === 'suggestion' ? 'Suggestion' : 'Bug';
  const issueHint = status === 'accepted'
    ? `\nUse !feedback issue ${id} to create a GitHub issue.`
    : '';
  return `${emoji} ${label} #${id} marked as ${bold(status)}.\n"${truncateText(entry.text, 100)}"${issueHint}`;
}

function formatFeedbackList(
  items: FeedbackEntry[],
  filter: 'open' | 'all',
): string {
  if (items.length === 0) {
    return filter === 'open'
      ? 'No open feedback items.'
      : 'No feedback items yet.';
  }

  const header = filter === 'open'
    ? `${bold('Open feedback')} (${items.length} item${items.length !== 1 ? 's' : ''}):`
    : `${bold('Recent feedback')} (${items.length} item${items.length !== 1 ? 's' : ''}):`;

  const lines = items.map((item) => {
    const emoji = item.type === 'suggestion' ? '💡' : '🐛';
    const statusBadge = item.status !== 'open' ? ` [${item.status}]` : '';
    const votes = item.upvotes > 0 ? ` (+${item.upvotes})` : '';
    const group = item.group_jid ? getGroupName(item.group_jid) : 'DM';
    const date = new Date(item.timestamp * 1000).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
    const issueLink = item.github_issue_url ? `\n   🔗 ${item.github_issue_url}` : '';
    return `${emoji} #${item.id}${statusBadge}${votes} — ${truncateText(item.text, 80)}\n   _${item.sender} · ${group} · ${date}_${issueLink}`;
  });

  return [header, '', ...lines].join('\n');
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}
