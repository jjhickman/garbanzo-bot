<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    ApiError,
    clearSession,
    exchangeEntryToken,
    getState,
    getWizardSchema,
    onSessionExpired,
    type ConfigState,
    type WizardSchema,
  } from './lib/api.js';
  import Editor from './lib/editor/Editor.svelte';
  import Wizard from './lib/wizard/Wizard.svelte';

  let entryToken = '';
  let state: ConfigState | null = null;
  let wizardSchema: WizardSchema | null = null;
  let pending = false;
  let error = '';

  const isConfigured = (configState: ConfigState): boolean => [
    ...Object.values(configState.envFiles),
    ...Object.values(configState.configFiles),
  ].some(Boolean);

  const unsubscribe = onSessionExpired(() => {
    state = null;
    wizardSchema = null;
    error = 'Your session expired. Paste the new one-time token from the terminal.';
  });

  async function connect(): Promise<void> {
    if (!entryToken.trim() || pending) return;
    pending = true;
    error = '';
    try {
      await exchangeEntryToken(entryToken.trim());
      entryToken = '';
      state = await getState();
      wizardSchema = isConfigured(state) ? null : await getWizardSchema();
    } catch (caught) {
      clearSession();
      state = null;
      wizardSchema = null;
      error = caught instanceof ApiError ? caught.message : 'Garbanzo could not connect to the config service.';
    } finally {
      entryToken = '';
      pending = false;
    }
  }

  onDestroy(unsubscribe);
</script>

<svelte:head>
  <title>{state ? `${state.instanceId ?? 'Garbanzo'} configuration` : 'Garbanzo configuration'}</title>
</svelte:head>

<div class="app-frame">
  <header class="masthead">
    <a class="brand" href="/" aria-label="Garbanzo configuration home">
      <span class="bean" aria-hidden="true">🫘</span>
      <span>Garbanzo</span>
    </a>
    <span class="security"><span class="status-dot"></span>Local config service</span>
  </header>

  {#if !state}
    <main class="login-layout">
      <section class="intro" aria-labelledby="login-heading">
        <p class="eyebrow">Browser configuration</p>
        <h1 id="login-heading">Connect to this Garbanzo host.</h1>
        <p class="lede">Paste the one-time token printed by <code>garbanzo config</code>. It is exchanged once and kept only in this tab's memory.</p>
      </section>

      <section class="card login-card">
        <form onsubmit={(event) => { event.preventDefault(); void connect(); }}>
          <label for="entry-token">One-time token</label>
          <div class="field-help" id="token-help">The token never enters browser storage or the address bar.</div>
          <input
            id="entry-token"
            name="entryToken"
            type="password"
            bind:value={entryToken}
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            aria-describedby="token-help"
            aria-invalid={error ? 'true' : 'false'}
            disabled={pending}
            required
          />
          {#if error}<p class="error" role="alert">{error}</p>{/if}
          <button type="submit" disabled={pending || !entryToken.trim()}>
            {pending ? 'Connecting…' : 'Connect securely'}
          </button>
        </form>
      </section>
    </main>
  {:else if isConfigured(state)}
    <main class="dashboard editor-dashboard"><Editor platform={state.platform ?? ''} /></main>
  {:else if wizardSchema}
    <main class="dashboard wizard-dashboard"><Wizard schema={wizardSchema} /></main>
  {:else}
    <main class="dashboard"><p class="muted">Loading wizard schema…</p></main>
  {/if}
</div>
