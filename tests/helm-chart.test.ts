import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

type ChartYaml = {
  apiVersion?: unknown;
  name?: unknown;
  version?: unknown;
  appVersion?: unknown;
};

type ValuesYaml = {
  image?: {
    repository?: unknown;
    tag?: unknown;
  };
  platform?: unknown;
  healthPort?: unknown;
  persistence?: {
    data?: {
      enabled?: unknown;
      size?: unknown;
      storageClass?: unknown;
    };
    whatsappAuth?: {
      enabled?: unknown;
      size?: unknown;
    };
  };
  qdrant?: {
    enabled?: unknown;
    url?: unknown;
  };
  resources?: {
    limits?: {
      memory?: unknown;
    };
  };
};

function parseYamlFile<T>(path: string): T {
  return load(readFileSync(path, 'utf-8')) as T;
}

function helmExists(): boolean {
  const result = spawnSync('helm', ['version', '--short'], { encoding: 'utf-8' });
  return result.status === 0;
}

describe('garbanzo helm chart', () => {
  const chartDir = 'deploy/helm/garbanzo';

  it('declares the expected chart identity and defaults', () => {
    const chart = parseYamlFile<ChartYaml>(`${chartDir}/Chart.yaml`);
    const values = parseYamlFile<ValuesYaml>(`${chartDir}/values.yaml`);

    expect(chart.apiVersion).toBe('v2');
    expect(chart.name).toBe('garbanzo');
    expect(chart.version).toBe('0.1.0');
    expect(chart.appVersion).toBe('3.0.0');

    expect(values.image?.repository).toBe('ghcr.io/jjhickman/garbanzo');
    expect(values.image?.tag).toBe('');
    expect(values.platform).toBe('discord');
    expect(values.healthPort).toBe(3002);
    expect(values.persistence?.data).toEqual({
      enabled: true,
      size: '1Gi',
      storageClass: '',
    });
    expect(values.persistence?.whatsappAuth).toEqual({
      enabled: false,
      size: '100Mi',
    });
    expect(values.qdrant).toEqual({
      enabled: false,
      url: '',
    });
    expect(values.resources?.limits?.memory).toBe('1Gi');
  });

  it('pins single-replica probes to the health endpoints', () => {
    const deployment = readFileSync(`${chartDir}/templates/deployment.yaml`, 'utf-8');

    expect(deployment).toContain('replicas: 1');
    expect(deployment).toContain('type: Recreate');
    expect(deployment).toContain('path: /health');
    expect(deployment).toContain('path: /health/ready');
  });

  // CI runners ship helm and a cold first run can exceed vitest's 5s default.
  it('passes helm lint when helm is installed', () => {
    if (!helmExists()) return;

    execFileSync('helm', ['lint', chartDir], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 25_000,
    });
  }, 30_000);
});
