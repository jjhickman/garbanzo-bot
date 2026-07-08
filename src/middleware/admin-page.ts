/**
 * Owner admin snapshot + page — usage, cost, and community-operations
 * visibility over the data the process already tracks, served token-gated
 * from the health server at /admin (HTML) and /admin.json (raw).
 *
 * Phase 1 (v3.3.0, WS4): everything here is READ-ONLY and derived per
 * request; there is no new persistent state and no mutation endpoints.
 * Sections: Overview, Memory ("Lore" alias), Bridges, Health, plus the
 * pre-existing usage/cost tables. The write-gate mechanism for phase 2 is
 * designed in docs/_internal/specs/2026-07-08-admin-write-gate-design.md —
 * phase 1 intentionally ships nothing it gates.
 */

import { readFileSync } from 'node:fs';

import { loadBridgeMap, type BridgeRoute } from '../bridge/bridge-map.js';
import { GROUP_IDS } from '../core/groups-config.js';
import { config, instanceId } from '../utils/config.js';
import { bridgeBufferDepths, bridgeOutboxCounts, getAllMemories, type BridgeOutboxCounts } from '../utils/db.js';
import { assetPath } from '../utils/paths.js';
import { getCurrentStats, getDailyCost, getLifetimeCounters, DAILY_COST_ALERT_THRESHOLD } from './stats.js';

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

/** Connection status as reported by the health server's in-process state. */
export type AdminConnectionStatus = 'connected' | 'disconnected' | 'connecting';

/** Memory-watchdog numbers as tracked by health.ts; passed in, not recomputed here. */
export interface AdminMemoryWatchdog {
  rssMB: number;
  warnMB: number;
  restartMB: number;
}

/**
 * Everything the Overview + Health sections need that only health.ts's
 * module-scoped connection/watchdog state knows. Passed in per request by
 * the /admin route handler (health.ts) rather than imported here, to avoid
 * a health.ts <-> admin-page.ts import cycle (health.ts already imports
 * buildAdminSnapshot/renderAdminHtml from this module at runtime).
 */
export interface AdminSnapshotInputs {
  connectionStatus: AdminConnectionStatus;
  uptimeSeconds: number;
  lastMessageAgoSeconds: number | null;
  stale: boolean;
  memoryWatchdog: AdminMemoryWatchdog;
}

export interface AdminOverviewSection {
  platform: string;
  instanceId: string;
  version: string;
  connectionStatus: AdminConnectionStatus;
  uptimeSeconds: number;
  lastMessageAgoSeconds: number | null;
  stale: boolean;
}

export interface AdminMemoryRow {
  id: number;
  fact: string;
  category: string;
  source: string;
  /**
   * True only when this row IS a shared-memory entry. getAllMemories() only
   * ever returns LOCAL rows (LocalMemoryEntry), so this is always false
   * today — whether a given local fact has separately been copied into the
   * shared Qdrant collection via `!memory share <id>` is tracked only in
   * that collection (keyed by `<instanceId>:<localId>`), which has no cheap
   * "list" or "exists" primitive in the current VectorStore interface.
   * Surfacing true per-fact shared status is left for a later phase rather
   * than faked here or implemented via N per-row vector lookups on every
   * admin page load.
   */
  shared: boolean;
}

export interface AdminMemorySection {
  /** Total stored local facts, regardless of how many are rendered below. */
  totalCount: number;
  /** Number of rows actually included in `rows` (== min(totalCount, cap)). */
  shownCount: number;
  cap: number;
  rows: AdminMemoryRow[];
}

export interface AdminBridgeRouteRow {
  id: string;
  endpointA: string;
  endpointB: string;
  direction: BridgeRoute['direction'];
  ingestRelayed: boolean;
}

export interface AdminBridgeSection {
  enabled: boolean;
  routes: AdminBridgeRouteRow[];
  outboxPending: number;
  outboxOldestPendingAgeSeconds: number | null;
  deadLettered: number;
  summaryBufferDepths: Record<string, number>;
}

export interface AdminHealthSection {
  aiRequestsByProvider: Record<string, number>;
  /** Lifetime AI errors across all groups — a proxy for fallback-triggering failures, not a direct fallback counter (none exists today). */
  aiErrorsTotal: number;
  memoryWatchdog: AdminMemoryWatchdog;
  bridgeFailedTotal: number;
  bridgeDeadLetteredTotal: number;
  metricsPath: string;
}

export interface AdminSnapshot {
  date: string;
  dailyCost: number;
  costAlertThreshold: number;
  ownerDMs: number;
  providers: AdminProviderRow[];
  groups: AdminGroupRow[];
  overview: AdminOverviewSection;
  memory: AdminMemorySection;
  bridges: AdminBridgeSection;
  health: AdminHealthSection;
}

/**
 * Cap on memory rows rendered in the /admin "Lore" browse table, newest
 * first. Large enough to browse a healthy community's fact base at a
 * glance, small enough that the page stays a single fast server render with
 * no pagination controls (phase 1 ships no interactivity). `totalCount`
 * always reflects the true total, so an operator with more facts than this
 * can tell there is more than what is shown.
 */
const MEMORY_ADMIN_DISPLAY_CAP = 100;

let cachedVersion: string | undefined;

function getVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const json = JSON.parse(readFileSync(assetPath('package.json'), 'utf8')) as { version?: string };
    cachedVersion = json.version ?? 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

function sumMapValues(map: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}

function buildMemorySection(memories: Array<{ id: number; fact: string; category: string; source: string; shared?: false }>): AdminMemorySection {
  const newestFirst = [...memories].sort((a, b) => b.id - a.id);
  const rows: AdminMemoryRow[] = newestFirst.slice(0, MEMORY_ADMIN_DISPLAY_CAP).map((m) => ({
    id: m.id,
    fact: m.fact,
    category: m.category,
    source: m.source,
    // getAllMemories() only returns local rows, so `shared` is always
    // false|undefined here (see the AdminMemoryRow.shared doc comment) —
    // Boolean(...) instead of `=== true` keeps that honest without TS
    // flagging an always-false literal comparison.
    shared: Boolean(m.shared),
  }));

  return {
    totalCount: memories.length,
    shownCount: rows.length,
    cap: MEMORY_ADMIN_DISPLAY_CAP,
    rows,
  };
}

function bridgeEndpointLabel(endpoint: { instance: string; chatId: string }): string {
  return `${endpoint.instance}:${endpoint.chatId}`;
}

function buildBridgesSection(
  now: number,
  outboxCounts: BridgeOutboxCounts,
  bufferDepths: Record<string, number>,
): AdminBridgeSection {
  // Bridging is only considered enabled when the flag is on AND a valid
  // bridge-map is loaded — a flag-on-but-unconfigured deployment renders
  // the same honest "not enabled" state rather than an empty route table
  // that could read as "configured, zero routes."
  const bridgeMap = config.BRIDGE_ENABLED ? loadBridgeMap() : null;
  const enabled = config.BRIDGE_ENABLED === true && bridgeMap !== null && bridgeMap.routes.length > 0;

  const routes: AdminBridgeRouteRow[] = enabled && bridgeMap
    ? bridgeMap.routes.map((route) => ({
      id: route.id,
      endpointA: bridgeEndpointLabel(route.endpoints[0]),
      endpointB: bridgeEndpointLabel(route.endpoints[1]),
      direction: route.direction,
      ingestRelayed: route.ingestRelayed,
    }))
    : [];

  const outboxOldestPendingAgeSeconds = outboxCounts.oldestPendingCreatedAt === null
    ? null
    : Math.max(0, Math.floor((now - outboxCounts.oldestPendingCreatedAt) / 1000));

  return {
    enabled,
    routes,
    outboxPending: outboxCounts.pending,
    outboxOldestPendingAgeSeconds,
    deadLettered: outboxCounts.dead,
    summaryBufferDepths: bufferDepths,
  };
}

function buildHealthSection(memoryWatchdog: AdminMemoryWatchdog): AdminHealthSection {
  const lifetime = getLifetimeCounters();

  return {
    aiRequestsByProvider: Object.fromEntries(lifetime.aiRequestsByProvider),
    aiErrorsTotal: sumMapValues(lifetime.aiErrorsByGroupJid),
    memoryWatchdog,
    bridgeFailedTotal: sumMapValues(lifetime.bridgeFailedByRoute),
    bridgeDeadLetteredTotal: sumMapValues(lifetime.bridgeDeadLetteredByRoute),
    metricsPath: '/metrics',
  };
}

function buildOverviewSection(inputs: AdminSnapshotInputs): AdminOverviewSection {
  return {
    platform: config.MESSAGING_PLATFORM,
    instanceId,
    version: getVersion(),
    connectionStatus: inputs.connectionStatus,
    uptimeSeconds: inputs.uptimeSeconds,
    lastMessageAgoSeconds: inputs.lastMessageAgoSeconds,
    stale: inputs.stale,
  };
}

export async function buildAdminSnapshot(inputs: AdminSnapshotInputs): Promise<AdminSnapshot> {
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

  const now = Date.now();
  const [memories, outboxCounts, bufferDepths] = await Promise.all([
    getAllMemories(),
    bridgeOutboxCounts(),
    bridgeBufferDepths(),
  ]);

  return {
    date: stats.date,
    dailyCost: getDailyCost(),
    costAlertThreshold: DAILY_COST_ALERT_THRESHOLD,
    ownerDMs: stats.ownerDMs,
    providers: [...providerTotals.values()].sort((a, b) => b.estimatedCost - a.estimatedCost),
    groups,
    overview: buildOverviewSection(inputs),
    memory: buildMemorySection(memories),
    bridges: buildBridgesSection(now, outboxCounts, bufferDepths),
    health: buildHealthSection(inputs.memoryWatchdog),
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

function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'never';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function renderOverviewSection(overview: AdminOverviewSection): string {
  return `<h2>Overview</h2>
<table><tbody>
<tr><td>Platform</td><td>${escapeHtml(overview.platform)}</td></tr>
<tr><td>Instance</td><td>${escapeHtml(overview.instanceId)}</td></tr>
<tr><td>Version</td><td>${escapeHtml(overview.version)}</td></tr>
<tr><td>Connection</td><td>${escapeHtml(overview.connectionStatus)}${overview.stale ? ' (stale)' : ''}</td></tr>
<tr><td>Uptime</td><td>${formatDuration(overview.uptimeSeconds)}</td></tr>
<tr><td>Last message</td><td>${formatDuration(overview.lastMessageAgoSeconds)} ago</td></tr>
</tbody></table>`;
}

function renderMemorySection(memory: AdminMemorySection): string {
  const rows = memory.rows.map((m) => {
    const sourceTag = m.source === 'auto' ? 'auto' : m.source === 'ai-tool' ? 'ai' : m.source;
    return `<tr><td>${m.id}</td><td>${escapeHtml(m.fact)}</td><td>${escapeHtml(m.category)}</td><td>${escapeHtml(sourceTag)}</td><td>${m.shared ? 'shared' : 'local'}</td></tr>`;
  }).join('') || '<tr><td colspan="5">No facts stored yet.</td></tr>';

  const capNote = memory.totalCount > memory.shownCount
    ? ` (showing the newest ${memory.shownCount} of ${memory.totalCount})`
    : '';

  return `<h2>Memory — your community's lore</h2>
<p class="muted">${memory.totalCount} fact${memory.totalCount === 1 ? '' : 's'} stored${capNote}</p>
<table><thead><tr><th>ID</th><th>Fact</th><th>Category</th><th>Source</th><th>Shared</th></tr></thead>
<tbody>${rows}</tbody></table>`;
}

function renderBridgesSection(bridges: AdminBridgeSection): string {
  if (!bridges.enabled) {
    return `<h2>Bridges</h2><p>Bridging is not enabled on this instance.</p>`;
  }

  const routeRows = bridges.routes.map((r) =>
    `<tr><td>${escapeHtml(r.id)}</td><td>${escapeHtml(r.endpointA)} &harr; ${escapeHtml(r.endpointB)}</td><td>${escapeHtml(r.direction)}</td><td>${r.ingestRelayed ? 'yes' : 'no'}</td></tr>`,
  ).join('') || '<tr><td colspan="4">No routes configured.</td></tr>';

  const bufferRows = Object.entries(bridges.summaryBufferDepths).map(
    ([route, depth]) => `<tr><td>${escapeHtml(route)}</td><td>${depth}</td></tr>`,
  ).join('') || '<tr><td colspan="2">No routes currently buffering.</td></tr>';

  return `<h2>Bridges</h2>
<table><thead><tr><th>Route</th><th>Endpoints</th><th>Direction</th><th>Ingests relayed</th></tr></thead>
<tbody>${routeRows}</tbody></table>
<p class="muted">Outbox: ${bridges.outboxPending} pending (oldest ${formatDuration(bridges.outboxOldestPendingAgeSeconds)}) · ${bridges.deadLettered} dead-lettered</p>
<h3>Summary buffers</h3>
<table><thead><tr><th>Route</th><th>Buffered messages</th></tr></thead>
<tbody>${bufferRows}</tbody></table>`;
}

function renderHealthSection(health: AdminHealthSection, metricsHref: string): string {
  const providerRows = Object.entries(health.aiRequestsByProvider).map(
    ([provider, calls]) => `<tr><td>${escapeHtml(provider)}</td><td>${calls}</td></tr>`,
  ).join('') || '<tr><td colspan="2">No AI requests yet.</td></tr>';

  const watchdogStatus = health.memoryWatchdog.rssMB >= health.memoryWatchdog.restartMB
    ? 'critical'
    : health.memoryWatchdog.rssMB >= health.memoryWatchdog.warnMB
      ? 'warn'
      : 'ok';

  return `<h2>Health</h2>
<table><thead><tr><th>Provider (lifetime requests)</th><th>Calls</th></tr></thead>
<tbody>${providerRows}</tbody></table>
<p class="muted">AI errors (lifetime, a proxy for fallback events): ${health.aiErrorsTotal}</p>
<p class="muted">Memory watchdog: ${health.memoryWatchdog.rssMB}MB RSS (${watchdogStatus}; warns at ${health.memoryWatchdog.warnMB}MB, restarts at ${health.memoryWatchdog.restartMB}MB)</p>
<p class="muted">Bridge failures (lifetime): ${health.bridgeFailedTotal} failed · ${health.bridgeDeadLetteredTotal} dead-lettered</p>
<p class="muted">Full history and per-route/per-provider breakdowns: <a href="${metricsHref}">${escapeHtml(health.metricsPath)}</a>. Historical trends and dashboards live in Grafana (see docs/MONITORING.md) — this page shows live numbers only.</p>`;
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

  const query = extra.rawQuery ? `?${escapeHtml(extra.rawQuery)}` : '';
  const safetyBlock = extra.whatsappSafety
    ? `<h3>WhatsApp outbound safety</h3><pre>${escapeHtml(JSON.stringify(extra.whatsappSafety, null, 2))}</pre>`
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
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; } h3 { font-size: .95rem; margin-top: 1.25rem; }
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
<p class="muted">auto-refreshes every 30s · raw: <a href="/admin.json${query}">/admin.json</a></p>

${renderOverviewSection(snapshot.overview)}

${renderMemorySection(snapshot.memory)}

${renderBridgesSection(snapshot.bridges)}

${renderHealthSection(snapshot.health, `/metrics${query}`)}

<h2>Usage &amp; cost (today)</h2>
<p>Daily AI spend: <strong>${usd(snapshot.dailyCost)}</strong> of ${usd(snapshot.costAlertThreshold)} alert threshold (${costPct}%)</p>
<div class="bar"><div style="width:${costPct}%"></div></div>
<p class="muted">Owner DMs today: ${snapshot.ownerDMs}</p>

<h3>Provider mix (today)</h3>
<table><thead><tr><th>Provider</th><th>Calls</th><th>Input tokens</th><th>Output tokens</th><th>Est. cost</th></tr></thead>
<tbody>${providerRows}</tbody></table>

<h3>Groups (today)</h3>
<table><thead><tr><th>Group</th><th>Messages</th><th>Active users</th><th>Bot replies</th><th>Mod flags</th><th>AI errors</th></tr></thead>
<tbody>${groupRows}</tbody></table>

${safetyBlock}
</body>
</html>`;
}
