<script lang="ts">
  import { ApiError, applyStream } from '../api.js';

  let { onApplied }: { onApplied?: () => void } = $props();

  let output = $state('');
  let pending = $state(false);
  let status = $state('');
  let failed = $state(false);

  async function apply(): Promise<void> {
    if (pending) return;
    output = '';
    status = '';
    failed = false;
    pending = true;
    try {
      const result = await applyStream((chunk) => { output += chunk; });
      if (result.exitCode === 0 || result.guidance) {
        status = 'Applied — the config service has exited; run `garbanzo config` again to continue.';
        // The session is gone and the server has exited; hand control to the
        // parent so the now-dead editor tabs are replaced with a terminal screen.
        onApplied?.();
      } else if (result.exitCode !== null) {
        failed = true;
        status = `Apply exited with code ${result.exitCode}. The config service is still available.`;
      } else {
        failed = true;
        status = 'The apply stream ended without a completion status.';
      }
    } catch (caught) {
      failed = true;
      status = caught instanceof ApiError ? caught.message : 'Apply could not be started.';
    } finally {
      pending = false;
    }
  }
</script>

<div class="card editor-card apply-panel">
  <p class="eyebrow">Apply changes</p>
  <h2>Restart the changed services.</h2>
  <p class="muted">Docker Compose output streams here live. Native deployments receive the exact restart guidance for this root. A successful apply closes this one-time config session.</p>
  <button type="button" disabled={pending} onclick={() => void apply()}>{pending ? 'Applying…' : 'Apply changes'}</button>
  <pre class="apply-console" aria-live="polite">{output || 'Apply output will appear here.'}</pre>
  {#if status}<p class:error={failed} class="editor-status" role="status">{status}</p>{/if}
</div>
