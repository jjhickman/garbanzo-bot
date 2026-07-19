<script lang="ts">
  import { ApiError, putConfigFile, type ConfigSnapshot } from '../api.js';

  type FileName = 'groups' | 'discord-channels' | 'telegram-chats' | 'matrix-rooms' | 'bridge-map';
  const fileNames: FileName[] = ['groups', 'discord-channels', 'telegram-chats', 'matrix-rooms', 'bridge-map'];
  let { snapshot, onReload }: { snapshot: ConfigSnapshot; onReload: () => Promise<void> } = $props();
  let selected = $state<FileName>('groups');
  let text = $state('');
  let initializedKey = '';
  let pending = $state(false);
  let status = $state('');
  let conflict = $state(false);
  let issues = $state<string[]>([]);
  const current = $derived(snapshot.files[selected]);

  $effect(() => {
    const key = `${selected}:${current?.mtimeMs ?? 0}:${current?.sha256 ?? ''}`;
    if (key === initializedKey) return;
    text = JSON.stringify(current?.value ?? {}, null, 2);
    initializedKey = key;
    status = '';
    conflict = false;
    issues = [];
  });

  function label(name: FileName): string {
    return name.split('-').map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ');
  }

  function issueText(issue: unknown): string {
    if (typeof issue === 'string') return issue;
    if (!issue || typeof issue !== 'object') return String(issue);
    const message = (issue as { message?: unknown }).message;
    return typeof message === 'string' ? message : JSON.stringify(issue);
  }

  async function save(): Promise<void> {
    if (pending) return;
    status = '';
    conflict = false;
    issues = [];
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      status = 'This file is not valid JSON.';
      return;
    }
    pending = true;
    try {
      await putConfigFile(selected, { mtimeMs: current?.mtimeMs ?? 0, sha256: current?.sha256 ?? null, value });
      await onReload();
      status = 'Config file saved.';
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        conflict = true;
        status = 'This config file changed on disk. Reload before saving again.';
      } else if (caught instanceof ApiError && caught.status === 422) {
        const details = caught.details;
        const values = details && typeof details === 'object' && 'issues' in details && Array.isArray(details.issues) ? details.issues : [];
        issues = values.map(issueText);
        status = 'This config file did not pass validation.';
      } else {
        status = caught instanceof Error ? caught.message : 'The config file could not be saved.';
      }
    } finally {
      pending = false;
    }
  }
</script>

<div class="card editor-card file-editor">
  <div class="file-picker" role="tablist" aria-label="Config files">
    {#each fileNames as name (name)}
      <button class:active={selected === name} type="button" role="tab" aria-selected={selected === name} onclick={() => { selected = name; }}>{label(name)}</button>
    {/each}
  </div>
  <div class="file-heading">
    <div><h2>{label(selected)}</h2><p class="muted">config/{selected}.json · last loaded mtime {current?.mtimeMs ?? 0}</p></div>
    {#if !current}<span class="file-state">New file</span>{/if}
  </div>
  <label class="visually-hidden" for="config-json">{label(selected)} JSON</label>
  <textarea id="config-json" name="config-json" bind:value={text} spellcheck="false" aria-describedby="file-json-help"></textarea>
  <p id="file-json-help" class="field-help">JSON is parsed in the browser and validated by the config service before it is written.</p>
  {#if status}<p class:error={conflict || issues.length > 0 || status.includes('not valid')} class="editor-status" role="status">{status}</p>{/if}
  {#if issues.length > 0}<ul class="error-list">{#each issues as issue, index (`${index}-${issue}`)}<li>{issue}</li>{/each}</ul>{/if}
  <div class="editor-actions">
    {#if conflict}<button class="secondary" type="button" onclick={() => void onReload()}>Reload</button>{/if}
    <button type="button" disabled={pending} onclick={() => void save()}>{pending ? 'Saving…' : 'Save config file'}</button>
  </div>
</div>
