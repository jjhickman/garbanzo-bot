<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    ApiError,
    clearSession,
    exchangeEntryToken,
    getState,
    onSessionExpired,
    type ConfigState,
    type DeploymentShape,
  } from './lib/api.js';

  let entryToken = '';
  let state: ConfigState | null = null;
  let pending = false;
  let error = '';

  const shapeLabels: Record<DeploymentShape, string> = {
    compose: 'Compose deployment',
    'package-repo': 'Package repository',
    bare: 'Native installation',
  };

  const platformLabel = (platform: string): string => platform.length > 0
    ? `${platform.charAt(0).toUpperCase()}${platform.slice(1)}`
    : 'Not detected';

  const unsubscribe = onSessionExpired(() => {
    state = null;
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
    } catch (caught) {
      clearSession();
      state = null;
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
  {:else}
    <main class="dashboard">
      <section class="hero" aria-labelledby="instance-heading">
        <div>
          <p class="eyebrow">{platformLabel(state.platform ?? '')} instance</p>
          <h1 id="instance-heading">{state.instanceId ?? 'Unconfigured instance'}</h1>
          <p class="lede">{shapeLabels[state.shape]} detected at <span class="path">{state.root}</span></p>
        </div>
        <div class="connected-badge"><span class="status-dot"></span>Connected</div>
      </section>

      <section class="overview-grid" aria-label="Deployment overview">
        <article class="card metric-card">
          <p class="card-label">Deployment</p>
          <p class="metric">{shapeLabels[state.shape]}</p>
          <p class="muted">{state.composeFiles.length ? state.composeFiles.join(', ') : 'No Compose file detected'}</p>
        </article>
        <article class="card metric-card">
          <p class="card-label">Detected platforms</p>
          <div class="chips">
            {#each state.platforms as platform (platform)}<span class="chip">{platformLabel(platform)}</span>{/each}
            {#if state.platforms.length === 0}<span class="muted">None yet</span>{/if}
          </div>
        </article>
      </section>

      <section class="card files-card" aria-labelledby="env-heading">
        <div class="section-heading">
          <div><p class="card-label">Configuration layers</p><h2 id="env-heading">Environment files</h2></div>
          <span class="count">{Object.values(state.envFiles).filter(Boolean).length} present</span>
        </div>
        <ul class="file-list">
          {#each Object.entries(state.envFiles) as [name, present] (name)}
            <li><span class="file-name">{name}</span><span class:present class="file-status">{present ? 'Present' : 'Missing'}</span></li>
          {/each}
        </ul>
      </section>

      <p class="next-note">Wizard and editor screens arrive in the next workstreams. This host connection is ready for them.</p>
    </main>
  {/if}
</div>

<style>
  :global(*) { box-sizing: border-box; }
  :global(:root) {
    color-scheme: light dark;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-synthesis: none;
    --bg: #f5f1e8;
    --surface: rgba(255, 253, 247, .88);
    --surface-strong: #fffdf7;
    --text: #20261e;
    --muted: #667060;
    --line: #d9d8cc;
    --accent: #2f6545;
    --accent-strong: #214c33;
    --accent-soft: #dcebdd;
    --danger: #a1382e;
    --shadow: 0 18px 50px rgba(44, 55, 39, .10);
    background: var(--bg);
    color: var(--text);
  }
  :global(body) { margin: 0; min-width: 20rem; min-height: 100vh; background: radial-gradient(circle at 75% 5%, rgba(193, 219, 186, .45), transparent 35rem), var(--bg); }
  :global(button), :global(input) { font: inherit; }
  :global(button:focus-visible), :global(input:focus-visible), :global(a:focus-visible) { outline: .2rem solid #75a987; outline-offset: .18rem; }
  .app-frame { min-height: 100vh; }
  .masthead { height: 4.75rem; display: flex; align-items: center; justify-content: space-between; max-width: 74rem; margin: 0 auto; padding: 0 1.5rem; border-bottom: 1px solid color-mix(in srgb, var(--line) 65%, transparent); }
  .brand { display: inline-flex; gap: .65rem; align-items: center; color: var(--text); text-decoration: none; font-weight: 760; letter-spacing: -.02em; }
  .bean { display: grid; place-items: center; width: 2rem; height: 2rem; border-radius: .65rem; background: var(--accent-soft); }
  .security, .connected-badge { display: inline-flex; align-items: center; gap: .5rem; color: var(--muted); font-size: .82rem; font-weight: 650; }
  .status-dot { width: .5rem; height: .5rem; border-radius: 50%; background: #3a8a59; box-shadow: 0 0 0 .22rem rgba(58, 138, 89, .12); }
  .login-layout { max-width: 70rem; margin: 0 auto; min-height: calc(100vh - 4.75rem); padding: 6rem 1.5rem; display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(19rem, .8fr); gap: clamp(2.5rem, 8vw, 7rem); align-items: center; }
  .eyebrow, .card-label { margin: 0 0 .7rem; color: var(--accent); font-size: .76rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
  h1 { max-width: 13ch; margin: 0; font-size: clamp(2.65rem, 7vw, 5.5rem); line-height: .98; letter-spacing: -.055em; }
  .lede { max-width: 40rem; margin: 1.5rem 0 0; color: var(--muted); font-size: clamp(1.05rem, 2vw, 1.24rem); line-height: 1.65; }
  code, .path, .file-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  code { padding: .12rem .32rem; border: 1px solid var(--line); border-radius: .3rem; background: var(--surface); }
  .card { border: 1px solid color-mix(in srgb, var(--line) 82%, transparent); border-radius: 1.25rem; background: var(--surface); box-shadow: var(--shadow); backdrop-filter: blur(18px); }
  .login-card { padding: clamp(1.5rem, 4vw, 2.4rem); }
  form { display: grid; gap: .75rem; }
  label { font-weight: 760; }
  .field-help, .muted { color: var(--muted); font-size: .88rem; line-height: 1.5; }
  input { width: 100%; margin-top: .35rem; padding: .9rem 1rem; border: 1px solid var(--line); border-radius: .65rem; background: var(--surface-strong); color: var(--text); }
  button { margin-top: .5rem; padding: .9rem 1rem; border: 0; border-radius: .65rem; background: var(--accent); color: white; font-weight: 760; cursor: pointer; transition: background .15s, transform .15s; }
  button:hover:not(:disabled) { background: var(--accent-strong); transform: translateY(-1px); }
  button:disabled { cursor: not-allowed; opacity: .58; }
  .error { margin: .25rem 0 0; color: var(--danger); font-size: .9rem; }
  .dashboard { max-width: 70rem; margin: 0 auto; padding: clamp(3rem, 7vw, 6rem) 1.5rem; }
  .hero { display: flex; justify-content: space-between; gap: 2rem; align-items: flex-start; margin-bottom: 3rem; }
  .hero h1 { max-width: 18ch; font-size: clamp(2.7rem, 6vw, 5rem); overflow-wrap: anywhere; }
  .connected-badge { flex: none; padding: .65rem .85rem; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); }
  .path { overflow-wrap: anywhere; color: var(--text); }
  .overview-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .metric-card, .files-card { padding: 1.35rem; }
  .metric { margin: 0 0 .6rem; font-size: 1.35rem; font-weight: 750; letter-spacing: -.025em; }
  .chips { display: flex; gap: .45rem; flex-wrap: wrap; }
  .chip, .count { padding: .38rem .62rem; border-radius: 999px; background: var(--accent-soft); color: var(--accent-strong); font-size: .78rem; font-weight: 750; }
  .files-card { margin-top: 1rem; }
  .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  h2 { margin: 0; font-size: 1.35rem; letter-spacing: -.025em; }
  .file-list { list-style: none; padding: 0; margin: 1.25rem 0 0; border-top: 1px solid var(--line); }
  .file-list li { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: .85rem 0; border-bottom: 1px solid var(--line); }
  .file-status { color: var(--muted); font-size: .8rem; font-weight: 700; }
  .file-status.present { color: var(--accent); }
  .next-note { margin: 1.5rem 0 0; color: var(--muted); font-size: .88rem; text-align: center; }
  @media (prefers-color-scheme: dark) {
    :global(:root) { --bg: #151713; --surface: rgba(31, 35, 29, .9); --surface-strong: #252922; --text: #f2f3eb; --muted: #aeb7a8; --line: #3b4137; --accent: #8ec49e; --accent-strong: #b8ddc1; --accent-soft: #253f2e; --danger: #f19489; --shadow: 0 18px 50px rgba(0, 0, 0, .24); }
    :global(body) { background: radial-gradient(circle at 75% 5%, rgba(48, 88, 59, .35), transparent 35rem), var(--bg); }
  }
  @media (max-width: 720px) {
    .masthead { padding: 0 1rem; }
    .security { font-size: 0; }
    .login-layout { grid-template-columns: 1fr; padding: 3.5rem 1rem; gap: 2.5rem; align-content: center; }
    .dashboard { padding: 3.5rem 1rem; }
    .hero { display: block; }
    .connected-badge { width: fit-content; margin-top: 1.5rem; }
    .overview-grid { grid-template-columns: 1fr; }
  }
  @media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
