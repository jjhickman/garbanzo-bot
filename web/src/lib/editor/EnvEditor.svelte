<script lang="ts">
  import { ApiError, putConfig, validateConfig, type ConfigSnapshot, type WizardField, type WizardSchema } from '../api.js';
  import EnvField from './EnvField.svelte';

  let { snapshot, schema, platform, onReload }: {
    snapshot: ConfigSnapshot;
    schema: WizardSchema;
    platform: string;
    onReload: () => Promise<void>;
  } = $props();

  const platformFields = $derived(schema.groups[platform as keyof typeof schema.groups] ?? []);
  const groups = $derived([
    { name: 'Shared settings', fields: schema.groups.shared },
    { name: `${platformLabel(platform)} settings`, fields: platformFields },
  ]);
  const fields = $derived(groups.flatMap((group) => group.fields));
  const fieldsByEnv = $derived(new Map(fields.map((field) => [field.env, field])));
  let values = $state<Record<string, string>>({});
  let baseline = $state<Record<string, string>>({});
  let cleared = $state<Record<string, boolean>>({});
  let initializedFor: ConfigSnapshot | null = null;
  let pending = $state(false);
  let status = $state('');
  let conflict = $state(false);
  let fieldIssues = $state<Record<string, string>>({});
  let issueList = $state<string[]>([]);

  $effect(() => {
    if (initializedFor === snapshot) return;
    const next: Record<string, string> = {};
    for (const field of fields) {
      const current = snapshot.env[field.env];
      next[field.env] = field.secret ? '' : typeof current === 'string' ? current : '';
    }
    values = next;
    baseline = { ...next };
    cleared = {};
    initializedFor = snapshot;
  });

  function platformLabel(value: string): string {
    return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : 'Platform';
  }

  function options(field: WizardField): string[] {
    if (field.env === 'WHATSAPP_LOGIN_MODE') return schema.whatsappLoginModes;
    if (field.env.endsWith('_CHAT_SCOPE')) return schema.chatScopes;
    return [];
  }

  function isSet(field: WizardField): boolean {
    const current = snapshot.env[field.env];
    return Boolean(current && typeof current === 'object' && current.set);
  }

  function setValue(key: string, value: string): void {
    values[key] = value;
    fieldIssues[key] = '';
    status = '';
  }

  function setCleared(key: string, value: boolean): void {
    cleared[key] = value;
    if (value) values[key] = '';
    fieldIssues[key] = '';
    status = '';
  }

  function update(): Record<string, string | null> {
    const result: Record<string, string | null> = {};
    for (const field of fields) {
      if (field.secret) {
        if (cleared[field.env]) result[field.env] = null;
        else if ((values[field.env] ?? '') !== '') result[field.env] = values[field.env] ?? '';
      } else if ((values[field.env] ?? '') !== (baseline[field.env] ?? '')) {
        result[field.env] = values[field.env] ?? '';
      }
    }
    return result;
  }

  function issueText(issue: unknown): string {
    if (typeof issue === 'string') return issue;
    if (!issue || typeof issue !== 'object') return String(issue);
    const message = (issue as { message?: unknown }).message;
    return typeof message === 'string' ? message : JSON.stringify(issue);
  }

  function mapIssues(details: unknown): void {
    fieldIssues = {};
    issueList = [];
    const issues = details && typeof details === 'object' && 'issues' in details && Array.isArray(details.issues) ? details.issues : [];
    for (const issue of issues) {
      const pathValue = issue && typeof issue === 'object' ? (issue as { path?: unknown }).path : [];
      const path = Array.isArray(pathValue) ? pathValue : typeof pathValue === 'string' ? [pathValue] : [];
      const key = [...path].reverse().find((part): part is string => typeof part === 'string' && fieldsByEnv.has(part));
      if (key) fieldIssues[key] = issueText(issue);
      else issueList = [...issueList, issueText(issue)];
    }
  }

  async function execute(mode: 'validate' | 'save'): Promise<void> {
    if (pending) return;
    const changes = update();
    pending = true;
    status = '';
    conflict = false;
    fieldIssues = {};
    issueList = [];
    try {
      if (mode === 'validate') {
        await validateConfig({ env: changes });
        status = 'Validation passed.';
      } else {
        if (Object.keys(changes).length === 0) {
          status = 'No settings have changed.';
          return;
        }
        await putConfig({
          mtimeMs: snapshot.mtimeMs,
          fileMtimes: snapshot.fileMtimes,
          fileHashes: snapshot.fileHashes,
          update: changes,
        });
        await onReload();
        status = 'Settings saved.';
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        conflict = true;
        status = 'Configuration changed on disk. Reload before saving again.';
      } else if (caught instanceof ApiError && caught.status === 422) {
        mapIssues(caught.details);
        status = 'Some configuration values need attention.';
      } else {
        status = caught instanceof Error ? caught.message : 'The settings request failed.';
      }
    } finally {
      pending = false;
    }
  }
</script>

<div class="card editor-card">
  <p class="muted editor-intro">Secret inputs always start empty. Leave one blank to keep it, enter a value to replace it, or explicitly clear it.</p>
  {#each groups as group (group.name)}
    <section class="settings-group">
      <h2>{group.name}</h2>
      <div class="field-grid">
        {#each group.fields as field (field.env)}
          <EnvField
            {field}
            value={values[field.env] ?? ''}
            secretSet={isSet(field)}
            cleared={cleared[field.env] ?? false}
            issue={fieldIssues[field.env]}
            options={options(field)}
            onValue={(value) => setValue(field.env, value)}
            onClear={(value) => setCleared(field.env, value)}
          />
        {/each}
      </div>
    </section>
  {/each}
  {#if status}<p class:error={conflict || issueList.length > 0 || Object.values(fieldIssues).some(Boolean)} class="editor-status" role="status">{status}</p>{/if}
  {#if issueList.length > 0}<ul class="error-list">{#each issueList as issue, index (`${index}-${issue}`)}<li>{issue}</li>{/each}</ul>{/if}
  <div class="editor-actions">
    {#if conflict}<button class="secondary" type="button" onclick={() => void onReload()}>Reload</button>{/if}
    <button class="secondary" type="button" disabled={pending} onclick={() => void execute('validate')}>Validate</button>
    <button type="button" disabled={pending} onclick={() => void execute('save')}>{pending ? 'Working…' : 'Save settings'}</button>
  </div>
</div>
