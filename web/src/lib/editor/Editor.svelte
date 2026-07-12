<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, getConfig, getWizardSchema, type ConfigSnapshot, type WizardSchema } from '../api.js';
  import ApplyPanel from './ApplyPanel.svelte';
  import ConfigFiles from './ConfigFiles.svelte';
  import EnvEditor from './EnvEditor.svelte';
  import TransferPanel from './TransferPanel.svelte';

  let { platform }: { platform: string } = $props();
  let snapshot = $state<ConfigSnapshot | null>(null);
  let schema = $state<WizardSchema | null>(null);
  let loading = $state(true);
  let error = $state('');
  let applied = $state(false);
  let tab = $state<'settings' | 'files' | 'transfer' | 'apply'>('settings');

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      [snapshot, schema] = await Promise.all([getConfig(), getWizardSchema()]);
    } catch (caught) {
      error = caught instanceof ApiError ? caught.message : 'The current configuration could not be loaded.';
    } finally {
      loading = false;
    }
  }

  async function reloadSnapshot(): Promise<void> {
    snapshot = await getConfig();
  }

  onMount(() => { void load(); });
</script>

<section class="editor-shell" aria-labelledby="editor-heading">
  <div class="editor-heading">
    <div>
      <p class="eyebrow">Configuration editor</p>
      <h1 id="editor-heading">Review and update this instance.</h1>
    </div>
    <p class="platform-badge">{platform || 'Unknown'} instance</p>
  </div>

  <!-- Once Apply succeeds the service has exited and the session is gone; hide the
       tab nav so the operator can't click into a now-dead editor tab (which would
       throw "Authentication required"). The Apply panel stays mounted so its
       streamed output and "service exited" message remain visible. -->
  {#if !applied}
    <nav class="editor-tabs" aria-label="Configuration sections">
      <button class:active={tab === 'settings'} type="button" onclick={() => { tab = 'settings'; }}>Settings</button>
      <button class:active={tab === 'files'} type="button" onclick={() => { tab = 'files'; }}>Config files</button>
      <button class:active={tab === 'transfer'} type="button" onclick={() => { tab = 'transfer'; }}>Transfer</button>
      <button class:active={tab === 'apply'} type="button" onclick={() => { tab = 'apply'; }}>Apply</button>
    </nav>
  {/if}

  {#if loading}
    <div class="card editor-card"><p class="muted">Loading current configuration…</p></div>
  {:else if error}
    <div class="card editor-card">
      <p class="error banner" role="alert">{error}</p>
      <button type="button" onclick={() => void load()}>Try again</button>
    </div>
  {:else if snapshot && schema}
    {#if applied || tab === 'apply'}
      <ApplyPanel onApplied={() => { applied = true; }} />
    {:else if tab === 'settings'}
      <EnvEditor {snapshot} {schema} {platform} onReload={reloadSnapshot} />
    {:else if tab === 'files'}
      <ConfigFiles {snapshot} onReload={reloadSnapshot} />
    {:else}
      <TransferPanel onReload={reloadSnapshot} />
    {/if}
  {/if}
</section>
