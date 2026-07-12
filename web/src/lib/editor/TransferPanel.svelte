<script lang="ts">
  import { ApiError, confirmImport, exportBundle, importBundle, type ImportPreview } from '../api.js';

  let { onReload }: { onReload: () => Promise<void> } = $props();

  let preview = $state<ImportPreview | null>(null);
  let changed = $state<string[]>([]);
  let pending = $state(false);
  let status = $state('');
  let failed = $state(false);

  function download(): void {
    void (async () => {
      pending = true;
      status = '';
      failed = false;
      try {
        const bundle = await exportBundle();
        const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'garbanzo-config-bundle.json';
        anchor.click();
        URL.revokeObjectURL(url);
        status = 'Redacted configuration bundle downloaded.';
      } catch (caught) {
        failed = true;
        status = caught instanceof Error ? caught.message : 'The configuration bundle could not be exported.';
      } finally {
        pending = false;
      }
    })();
  }

  async function stage(file: File): Promise<void> {
    pending = true;
    status = '';
    failed = false;
    preview = null;
    changed = [];
    try {
      preview = await importBundle(file);
      status = 'Import is staged. Review the redacted diff before confirming.';
    } catch (caught) {
      failed = true;
      status = caught instanceof ApiError && caught.status === 422
        ? 'The bundle did not pass import validation.'
        : caught instanceof Error ? caught.message : 'The bundle could not be staged.';
    } finally {
      pending = false;
    }
  }

  async function confirm(): Promise<void> {
    if (!preview || pending) return;
    pending = true;
    status = '';
    failed = false;
    try {
      const result = await confirmImport(preview.stagingId);
      changed = result.changed;
      await onReload();
      preview = null;
      status = 'Import applied.';
    } catch (caught) {
      failed = true;
      status = caught instanceof ApiError && caught.status === 409
        ? 'Configuration changed on disk. Choose the bundle again to re-stage it.'
        : caught instanceof ApiError && caught.status === 422
          ? 'The staged bundle no longer passes validation.'
          : caught instanceof Error ? caught.message : 'The import could not be confirmed.';
    } finally {
      pending = false;
    }
  }

  function selected(event: Event): void {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (file) void stage(file);
  }

  function dropped(event: DragEvent): void {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (file) void stage(file);
  }
</script>

<div class="transfer-grid">
  <section class="card editor-card">
    <p class="eyebrow">Export</p>
    <h2>Download a redacted bundle.</h2>
    <p class="muted">Secrets are replaced by safe placeholders by the config service.</p>
    <button type="button" disabled={pending} onclick={download}>Download export</button>
  </section>
  <div class="card editor-card" role="region" aria-label="Import configuration bundle" ondragover={(event) => event.preventDefault()} ondrop={dropped}>
    <p class="eyebrow">Import</p>
    <h2>Stage and review a bundle.</h2>
    <label class="drop-zone" for="import-bundle">Drop a JSON bundle here, or choose a file.</label>
    <input id="import-bundle" name="import-bundle" type="file" accept="application/json,.json" disabled={pending} onchange={selected} />
  </div>
</div>
{#if preview}
  <section class="card editor-card import-preview">
    <h2>Redacted import diff</h2>
    <pre>{JSON.stringify(preview.diff, null, 2)}</pre>
    <div class="editor-actions"><button type="button" disabled={pending} onclick={() => void confirm()}>Confirm import</button></div>
  </section>
{/if}
{#if changed.length > 0}
  <section class="card editor-card"><h2>Changed files</h2><ul>{#each changed as file (file)}<li>{file}</li>{/each}</ul></section>
{/if}
{#if status}<p class:error={failed} class="editor-status transfer-status" role="status">{status}</p>{/if}
