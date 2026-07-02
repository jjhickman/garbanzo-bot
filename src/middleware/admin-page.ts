/**
 * Owner admin snapshot + page — usage and cost visibility over the data the
 * process already tracks (middleware/stats.ts), served token-gated from the
 * health server at /admin (HTML) and /admin.json (raw).
 *
 * Everything here is read-only and derived per request; there is no new
 * persistent state.
 */

import { getCurrentStats, getDailyCost, DAILY_COST_ALERT_THRESHOLD } from './stats.js';
import { GROUP_IDS } from '../core/groups-config.js';

export interface AdminGroupRow {
  jid: string;
  name: string;
  messages: number;
  activeUsers: number;
  botResponses: number;
  moderationFlags: number;
  aiErrors: number;
}

export interface AdminProviderRow {
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

export interface AdminSnapshot {
  date: string;
  dailyCost: number;
  costAlertThreshold: number;
  ownerDMs: number;
  providers: AdminProviderRow[];
  groups: AdminGroupRow[];
}

export function buildAdminSnapshot(): AdminSnapshot {
  const stats = getCurrentStats();

  const providerTotals = new Map<string, AdminProviderRow>();
  for (const entry of stats.costs) {
    let row = providerTotals.get(entry.model);
    if (!row) {
      row = { provider: entry.model, calls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
      providerTotals.set(entry.model, row);
    }
    row.calls += 1;
    row.inputTokens += entry.inputTokens;
    row.outputTokens += entry.outputTokens;
    row.estimatedCost += entry.estimatedCost;
  }

  const groups: AdminGroupRow[] = [...stats.groups.entries()].map(([jid, g]) => ({
    jid,
    name: GROUP_IDS[jid]?.name ?? jid,
    messages: g.messageCount,
    activeUsers: g.activeUsers.size,
    botResponses: g.botResponses,
    moderationFlags: g.moderationFlags,
    aiErrors: g.aiErrors,
  })).sort((a, b) => b.messages - a.messages);

  return {
    date: stats.date,
    dailyCost: getDailyCost(),
    costAlertThreshold: DAILY_COST_ALERT_THRESHOLD,
    ownerDMs: stats.ownerDMs,
    providers: [...providerTotals.values()].sort((a, b) => b.estimatedCost - a.estimatedCost),
    groups,
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function usd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

/**
 * Server-rendered snapshot page. Deliberately dependency-free (inline CSS,
 * meta-refresh instead of JS) so it works from any browser on the LAN.
 */
export function renderAdminHtml(
  snapshot: AdminSnapshot,
  extra: { whatsappSafety?: unknown; rawQuery?: string },
): string {
  const providerRows = snapshot.providers.map((p) =>
    `<tr><td>${escapeHtml(p.provider)}</td><td>${p.calls}</td><td>${p.inputTokens.toLocaleString()}</td><td>${p.outputTokens.toLocaleString()}</td><td>${usd(p.estimatedCost)}</td></tr>`,
  ).join('') || '<tr><td colspan="5">No AI calls yet today</td></tr>';

  const groupRows = snapshot.groups.map((g) =>
    `<tr><td>${escapeHtml(g.name)}</td><td>${g.messages}</td><td>${g.activeUsers}</td><td>${g.botResponses}</td><td>${g.moderationFlags}</td><td>${g.aiErrors}</td></tr>`,
  ).join('') || '<tr><td colspan="6">No group activity yet today</td></tr>';

  const costPct = snapshot.costAlertThreshold > 0
    ? Math.min(100, Math.round((snapshot.dailyCost / snapshot.costAlertThreshold) * 100))
    : 0;

  const safetyBlock = extra.whatsappSafety
    ? `<h2>WhatsApp outbound safety</h2><pre>${escapeHtml(JSON.stringify(extra.whatsappSafety, null, 2))}</pre>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Garbanzo Admin</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 60rem; color: #222; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid #ddd; font-variant-numeric: tabular-nums; }
  th { background: #f4f4f4; }
  .bar { background: #eee; height: .6rem; border-radius: .3rem; overflow: hidden; margin-top: .25rem; }
  .bar > div { background: #4a90d9; height: 100%; }
  .muted { color: #777; font-size: .85rem; }
</style>
</head>
<body>
<h1>🫘 Garbanzo — ${escapeHtml(snapshot.date)}</h1>
<p>Daily AI spend: <strong>${usd(snapshot.dailyCost)}</strong> of ${usd(snapshot.costAlertThreshold)} alert threshold (${costPct}%)</p>
<div class="bar"><div style="width:${costPct}%"></div></div>
<p class="muted">Owner DMs today: ${snapshot.ownerDMs} · auto-refreshes every 30s · raw: <a href="/admin.json${extra.rawQuery ? `?${escapeHtml(extra.rawQuery)}` : ''}">/admin.json</a></p>

<h2>Provider mix (today)</h2>
<table><thead><tr><th>Provider</th><th>Calls</th><th>Input tokens</th><th>Output tokens</th><th>Est. cost</th></tr></thead>
<tbody>${providerRows}</tbody></table>

<h2>Groups (today)</h2>
<table><thead><tr><th>Group</th><th>Messages</th><th>Active users</th><th>Bot replies</th><th>Mod flags</th><th>AI errors</th></tr></thead>
<tbody>${groupRows}</tbody></table>

${safetyBlock}
</body>
</html>`;
}
