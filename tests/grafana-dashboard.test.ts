import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

type PrometheusScrapeConfig = {
  job_name?: unknown;
  metrics_path?: unknown;
  authorization?: unknown;
  static_configs?: unknown;
};

type PrometheusConfig = {
  scrape_configs?: PrometheusScrapeConfig[];
};

type Dashboard = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePrometheusConfig(): PrometheusConfig {
  const parsed = load(readFileSync('monitoring/prometheus.yml', 'utf-8'));
  expect(isRecord(parsed)).toBe(true);
  return parsed as PrometheusConfig;
}

function parseDashboard(): Dashboard {
  const parsed = JSON.parse(
    readFileSync('monitoring/grafana/dashboards/garbanzo.json', 'utf-8'),
  ) as unknown;
  expect(isRecord(parsed)).toBe(true);
  return parsed;
}

function walk(value: unknown, visit: (item: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }

  if (!isRecord(value)) return;

  visit(value);

  for (const child of Object.values(value)) {
    walk(child, visit);
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

describe('monitoring dashboard and scrape config', () => {
  it('scrapes the Discord, WhatsApp, and Telegram bot instances with bearer token auth', () => {
    const prometheus = parsePrometheusConfig();
    const scrapeConfigs = prometheus.scrape_configs ?? [];
    const jobs = new Map(
      scrapeConfigs.map((config) => [String(config.job_name), config]),
    );

    expect([...jobs.keys()].sort()).toEqual(['discord', 'matrix', 'prometheus', 'telegram', 'whatsapp']);
    expect(jobs.has('garbanzo')).toBe(false);

    for (const [jobName, target] of [
      ['discord', 'discord:${DISCORD_HEALTH_PORT:-3002}'],
      ['whatsapp', 'whatsapp:${WHATSAPP_HEALTH_PORT:-3001}'],
      ['telegram', 'telegram:${TELEGRAM_HEALTH_PORT:-3005}'],
      ['matrix', 'matrix:${MATRIX_HEALTH_PORT:-3004}'],
    ] as const) {
      const job = jobs.get(jobName);
      expect(job).toBeDefined();
      expect(job?.metrics_path).toBe('/metrics');
      expect(job?.authorization).toEqual({
        type: 'Bearer',
        credentials_file: '/prometheus/token',
      });

      const staticConfigs = Array.isArray(job?.static_configs) ? job.static_configs : [];
      const targets = staticConfigs.flatMap((config) =>
        isRecord(config) ? stringList(config.targets) : [],
      );
      expect(targets).toEqual([target]);
    }

    const prometheusJob = jobs.get('prometheus');
    const prometheusStaticConfigs = Array.isArray(prometheusJob?.static_configs)
      ? prometheusJob.static_configs
      : [];
    const prometheusTargets = prometheusStaticConfigs.flatMap((config) =>
      isRecord(config) ? stringList(config.targets) : [],
    );
    expect(prometheusTargets).toEqual(['localhost:${PROMETHEUS_PORT:-9090}']);
  });

  it('keeps every Garbanzo metric panel scoped by the dashboard job variable', () => {
    const dashboard = parseDashboard();
    const dashboardDatasource = { type: 'prometheus', uid: 'garbanzo-prom' };
    const templating = isRecord(dashboard.templating) ? dashboard.templating : {};
    const templateList = Array.isArray(templating.list) ? templating.list : [];
    const jobVariable = templateList.find(
      (item): item is Record<string, unknown> =>
        isRecord(item) && item.name === 'job',
    );

    expect(jobVariable).toBeDefined();
    expect(jobVariable).toMatchObject({
      name: 'job',
      type: 'query',
      datasource: dashboardDatasource,
      query: 'label_values(job)',
      multi: true,
      includeAll: true,
      // refresh: 1 = "On Dashboard Load" — a stale (never-refreshing)
      // template variable list can silently drift from the live set of
      // jobs/instances Prometheus is actually scraping.
      refresh: 1,
      current: {
        selected: true,
        text: 'All',
        value: '$__all',
      },
    });

    const instanceVariable = templateList.find(
      (item): item is Record<string, unknown> =>
        isRecord(item) && item.name === 'instance',
    );

    expect(instanceVariable).toBeDefined();
    expect(instanceVariable).toMatchObject({
      name: 'instance',
      type: 'query',
      datasource: dashboardDatasource,
      query: 'label_values(garbanzo_up_time_seconds{job=~"$job"}, instance)',
      multi: true,
      includeAll: true,
      refresh: 1,
      current: {
        selected: true,
        text: 'All',
        value: '$__all',
      },
    });

    const titles: string[] = [];
    const expressions: string[] = [];
    walk(dashboard, (item) => {
      if (typeof item.title === 'string') titles.push(item.title);
      if (typeof item.expr === 'string') expressions.push(item.expr);
    });

    expect(titles).toEqual([
      'Garbanzo — Community Ops',
      'Platform Connection',
      'Connected',
      'Last message age',
      'Stale connection',
      'Reconnects per 6h',
      'Message Flow',
      'Messages per hour by group',
      'Bot replies per hour by group',
      'Active users today by group',
      'Owner DMs and rate limits',
      'MarkdownV2 fallbacks',
      'AI Provider Fallback and Latency',
      'AI requests per hour by provider',
      'AI latency average by provider',
      'AI cost per day by provider',
      'Tool calls per hour',
      'AI and tool errors per hour',
      'Bridge Health',
      'Outbox depth and oldest age',
      'Outbox delivery outcomes per hour',
      'Summary buffer size and flushes',
      'Dedup hits and safety-held relays',
      'Relay delivery latency window',
      'Memory Growth',
      'Memory facts by source',
      'Memory saves rejected per hour',
      'Event reminders',
      'Moderation flags per day',
      'Process memory',
    ]);
    expect(expressions).toHaveLength(35);

    const unscopedGarbanzoExpressions = expressions.filter(
      (expr) => expr.includes('garbanzo_')
        && (!expr.includes('job=~"$job"') || !expr.includes('instance=~"$instance"')),
    );
    expect(unscopedGarbanzoExpressions).toEqual([]);
    expect(expressions.some((expr) => expr.includes('instance_id'))).toBe(false);
  });
});
