<script lang="ts">
  import { ApiError, submitWizard, type WizardField, type WizardResult, type WizardSchema } from '../api.js';
  import FieldControl from './FieldControl.svelte';

  let { schema }: { schema: WizardSchema } = $props();

  const steps = ['Platform', 'Deployment', 'AI providers', 'Persona & features', 'Platform config', 'Review & Create'];
  const allFields = $derived(Object.values(schema.groups).flat());
  const fieldsByEnv = $derived(new Map(allFields.map((field) => [field.env, field])));
  const featureKeys = new Set(['BRIDGE_ENABLED', 'SHARED_MEMORY_ENABLED', 'BAND_FEATURES_ENABLED']);
  const featureFields = $derived(allFields.filter((field) => featureKeys.has(field.env)));
  const monitoringField = $derived(fieldsByEnv.get('MONITORING_TOKEN'));

  function isBoolean(field: WizardField): boolean {
    return field.default === 'true' || field.default === 'false' || field.env.endsWith('_ENABLED');
  }

  let values = $state<Record<string, string>>({});
  let valuesInitialized = false;
  $effect(() => {
    if (valuesInitialized) return;
    for (const field of allFields) {
      values[field.env] = field.secret ? '' : isBoolean(field) ? field.default || 'false' : field.default;
    }
    valuesInitialized = true;
  });
  let platform = $derived(schema.defaultPlatform);
  let deployTarget = $derived(schema.deployTargets[0] ?? 'docker');
  let selectedProviders = $derived(schema.providers.length > 0 ? [schema.providers[0] as string] : [] as string[]);
  let openaiAuthMode = $derived(schema.openaiAuthModes[0] ?? 'apikey');
  let vectorStore = $derived(schema.vectorStores[0] ?? 'qdrant');
  let persona = $state('default');
  let step = $state(0);
  let pending = $state(false);
  let error = $state('');
  let fieldIssues = $state<Record<string, string>>({});
  let issueList = $state<string[]>([]);
  let result = $state<WizardResult | null>(null);
  let bindings = $state([{ id: '', name: 'general' }]);

  function platformLabel(value: string): string {
    return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : 'Unknown';
  }

  function platformFields(): WizardField[] {
    const group = schema.groups[platform as keyof typeof schema.groups];
    return group ?? [];
  }

  function providerFields(): WizardField[] {
    return selectedProviders.flatMap((provider) => {
      const prefix = provider.toUpperCase();
      return schema.groups.shared.filter((field) => {
        if (provider === 'openai' && openaiAuthMode === 'oauth' && field.env === 'OPENAI_API_KEY') return false;
        if (provider === 'ollama') return field.env === 'OLLAMA_BASE_URL';
        return field.env.startsWith(`${prefix}_`)
          && (field.env.endsWith('_API_KEY') || field.env.includes('_MODEL'));
      });
    });
  }

  function fieldOptions(field: WizardField): string[] {
    if (field.env === 'WHATSAPP_LOGIN_MODE') return schema.whatsappLoginModes;
    if (field.env.endsWith('_CHAT_SCOPE')) return schema.chatScopes;
    return [];
  }

  function setValue(key: string, value: string): void {
    values[key] = value;
    fieldIssues[key] = '';
  }

  function toggleProvider(provider: string): void {
    selectedProviders = selectedProviders.includes(provider)
      ? selectedProviders.filter((selected) => selected !== provider)
      : [...selectedProviders, provider];
  }

  function moveProvider(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= selectedProviders.length) return;
    const reordered = [...selectedProviders];
    [reordered[index], reordered[target]] = [reordered[target] as string, reordered[index] as string];
    selectedProviders = reordered;
  }

  function validateStep(): boolean {
    if (step === 0 && !platform) error = 'Choose a messaging platform.';
    else if (step === 1 && !deployTarget) error = 'Choose a deployment target.';
    else if (step === 2 && selectedProviders.length === 0) error = 'Choose at least one AI provider.';
    else if (step === 3 && !persona.trim()) error = 'Enter a persona gallery name.';
    else if (step === 4 && platform !== 'slack' && !bindings.some((binding) => binding.id.trim())) {
      error = `Add at least one ${bindingNoun()} ID.`;
    }
    else error = '';
    return !error;
  }

  function next(): void {
    if (validateStep()) step = Math.min(step + 1, steps.length - 1);
  }

  function payload(): Record<string, string> {
    const fields: Record<string, string> = {
      MESSAGING_PLATFORM: platform,
      DEPLOY_TARGET: deployTarget,
      AI_PROVIDER_ORDER: selectedProviders.join(','),
      VECTOR_STORE: vectorStore,
      persona: persona.trim(),
    };
    if (selectedProviders.includes('openai')) fields.OPENAI_AUTH_MODE = openaiAuthMode;
    const selectedFields = [...providerFields(), ...featureFields, ...(monitoringField ? [monitoringField] : []), ...platformFields()];
    for (const field of selectedFields) fields[field.env] = values[field.env] ?? '';
    return fields;
  }

  function bindingNoun(): string {
    if (platform === 'discord') return 'channel';
    if (platform === 'telegram') return 'chat';
    if (platform === 'matrix') return 'room';
    return 'group';
  }

  function bindingArgs(): string[] {
    const entries = bindings.filter((binding) => binding.id.trim());
    if (entries.length === 0) return [];
    const ids = entries.map((binding) => binding.id.trim()).join(',');
    const name = entries[0]?.name.trim() || 'general';
    if (platform === 'discord') return [`--discord-channel-ids=${ids}`, `--discord-channel-name=${name}`];
    if (platform === 'telegram') return [`--telegram-chat-ids=${ids}`, `--telegram-chat-name=${name}`];
    if (platform === 'matrix') return [`--matrix-room-ids=${ids}`, `--matrix-room-name=${name}`];
    if (platform === 'whatsapp') return [`--group-id=${entries[0]?.id.trim() ?? ''}`, `--group-name=${name}`];
    return [];
  }

  function updateBinding(index: number, key: 'id' | 'name', value: string): void {
    bindings[index] = { ...bindings[index], [key]: value } as { id: string; name: string };
  }

  const secretKeys = $derived(new Set(allFields.filter((field) => field.secret).map((field) => field.env)));

  function issueText(issue: unknown): string {
    if (typeof issue === 'string') return issue;
    if (!issue || typeof issue !== 'object') return String(issue);
    const record = issue as { message?: unknown };
    return typeof record.message === 'string' ? record.message : JSON.stringify(issue);
  }

  function mapIssues(details: unknown): void {
    fieldIssues = {};
    issueList = [];
    if (!details || typeof details !== 'object' || !('issues' in details) || !Array.isArray(details.issues)) return;
    for (const issue of details.issues) {
      const record = issue && typeof issue === 'object' ? issue as { path?: unknown } : {};
      const path = Array.isArray(record.path) ? record.path : typeof record.path === 'string' ? [record.path] : [];
      const key = [...path].reverse().find((part): part is string => typeof part === 'string' && fieldsByEnv.has(part));
      if (key) fieldIssues[key] = issueText(issue);
      else issueList = [...issueList, issueText(issue)];
    }
  }

  async function create(): Promise<void> {
    if (pending) return;
    pending = true;
    error = '';
    fieldIssues = {};
    issueList = [];
    try {
      result = await submitWizard(payload(), bindingArgs());
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        error = 'The config root is not empty. Refresh the state or use the editor to change existing configuration.';
      } else if (caught instanceof ApiError && caught.status === 422) {
        mapIssues(caught.details);
        const detail = caught.details;
        const runnerMessage = detail && typeof detail === 'object' && 'message' in detail && typeof (detail as { message?: unknown }).message === 'string'
          ? (detail as { message: string }).message
          : '';
        error = runnerMessage
          || (issueList.length > 0 || Object.keys(fieldIssues).length > 0
            ? 'Some configuration values need attention.'
            : 'Setup could not complete. Check your entries and try again.');
        step = 4;
      } else {
        error = caught instanceof Error ? caught.message : 'Garbanzo could not create the configuration.';
      }
    } finally {
      pending = false;
    }
  }
</script>

{#if result}
  <section class="card success-panel" aria-labelledby="success-heading">
    <p class="eyebrow">Configuration created</p>
    <h1 id="success-heading">Your first-run files are ready.</h1>
    <ul class="written-files">{#each result.written as file (file)}<li>{file}</li>{/each}</ul>
    <p class="next-note">Next: review the generated configuration, then use Apply.</p>
  </section>
{:else}
  <section class="wizard-shell" aria-labelledby="wizard-heading">
    <div class="wizard-heading">
      <div><p class="eyebrow">First-run setup</p><h1 id="wizard-heading">Configure this instance.</h1></div>
      <p class="step-count">Step {step + 1} of {steps.length}</p>
    </div>

    <ol class="stepper" aria-label="Wizard progress">
      {#each steps as label, index (label)}
        <li class:active={index === step} class:complete={index < step}><span>{index + 1}</span>{label}</li>
      {/each}
    </ol>

    <div class="card wizard-card">
      {#if step === 0}
        <fieldset><legend>Messaging platform</legend><p class="muted">One Garbanzo process runs one platform.</p>
          <div class="choice-grid">{#each schema.platforms as option (option)}<label class="choice"><input type="radio" name="platform" value={option} bind:group={platform} /><span>{platformLabel(option)}</span></label>{/each}</div>
        </fieldset>
      {:else if step === 1}
        <fieldset><legend>Deployment</legend><div class="choice-grid">{#each schema.deployTargets as option (option)}<label class="choice"><input type="radio" name="deploy" value={option} bind:group={deployTarget} /><span>{option === 'docker' ? 'Docker Compose' : 'Native Node.js'}</span></label>{/each}</div></fieldset>
      {:else if step === 2}
        <fieldset><legend>AI provider order</legend><p class="muted">Select providers, then arrange them from primary to last fallback.</p>
          <div class="provider-list">{#each schema.providers as provider (provider)}<label class="toggle"><input type="checkbox" checked={selectedProviders.includes(provider)} onchange={() => toggleProvider(provider)} /><span>{platformLabel(provider)}</span></label>{/each}</div>
          {#if selectedProviders.length > 0}<ol class="provider-order">{#each selectedProviders as provider, index (provider)}<li><span>{index + 1}. {platformLabel(provider)}</span><span class="order-actions"><button type="button" aria-label={`Move ${provider} up`} disabled={index === 0} onclick={() => moveProvider(index, -1)}>↑</button><button type="button" aria-label={`Move ${provider} down`} disabled={index === selectedProviders.length - 1} onclick={() => moveProvider(index, 1)}>↓</button></span></li>{/each}</ol>{/if}
        </fieldset>
        {#if selectedProviders.includes('openai')}<div class="field"><label for="openai-auth-mode">OpenAI auth mode</label><select id="openai-auth-mode" bind:value={openaiAuthMode}>{#each schema.openaiAuthModes as mode (mode)}<option value={mode}>{mode}</option>{/each}</select></div>{/if}
        <div class="field-grid">{#each providerFields() as field (field.env)}<FieldControl {field} value={values[field.env] ?? ''} issue={fieldIssues[field.env]} onChange={(value) => setValue(field.env, value)} />{/each}</div>
      {:else if step === 3}
        <div class="field"><label for="persona">Persona gallery name</label><input id="persona" name="persona" type="text" bind:value={persona} /><p class="field-help">Use a gallery name such as default, quill, riff, or callie. Custom persona files remain a CLI-only option for now.</p></div>
        <div class="field"><label for="vector-store">Vector store</label><select id="vector-store" bind:value={vectorStore}>{#each schema.vectorStores as store (store)}<option value={store}>{store}</option>{/each}</select></div>
        <div class="field-grid">{#each featureFields as field (field.env)}{#if field.env !== 'BAND_FEATURES_ENABLED' || platform === 'discord'}<FieldControl {field} value={values[field.env] ?? ''} onChange={(value) => setValue(field.env, value)} />{/if}{/each}
          {#if monitoringField}<FieldControl field={monitoringField} value={values[monitoringField.env] ?? ''} onChange={(value) => setValue(monitoringField.env, value)} />{/if}
        </div>
      {:else if step === 4}
        <h2>{platformLabel(platform)} configuration</h2><div class="field-grid">{#each platformFields() as field (field.env)}<FieldControl {field} value={values[field.env] ?? ''} options={fieldOptions(field)} issue={fieldIssues[field.env]} onChange={(value) => setValue(field.env, value)} />{/each}</div>
        {#if platform !== 'slack'}
          <fieldset class="bindings"><legend>{platformLabel(platform)} {bindingNoun()} bindings</legend><p class="muted">Add the IDs this instance should serve. The first label is used for newly generated entries.</p>
            {#each bindings as binding, index (index)}<div class="binding-row"><label>ID<input name={`binding-${index}-id`} type="text" value={binding.id} oninput={(event) => updateBinding(index, 'id', event.currentTarget.value)} /></label><label>Label<input name={`binding-${index}-name`} type="text" value={binding.name} oninput={(event) => updateBinding(index, 'name', event.currentTarget.value)} /></label>{#if bindings.length > 1}<button class="secondary" type="button" onclick={() => { bindings = bindings.filter((_, bindingIndex) => bindingIndex !== index); }}>Remove</button>{/if}</div>{/each}
            {#if platform !== 'whatsapp'}<button class="secondary" type="button" onclick={() => { bindings = [...bindings, { id: '', name: bindings[0]?.name || 'general' }]; }}>Add another</button>{/if}
          </fieldset>
        {/if}
      {:else}
        <h2>Review configuration</h2><dl class="review-list">{#each Object.entries(payload()) as [key, value] (key)}<div><dt>{key}</dt><dd>{secretKeys.has(key) ? (value ? 'set' : 'not set') : value || 'not set'}</dd></div>{/each}</dl>
        {#if bindings.some((binding) => binding.id.trim())}<h3>Bindings</h3><ul class="written-files">{#each bindings.filter((binding) => binding.id.trim()) as binding, index (`${index}-${binding.id}`)}<li>{binding.id} ({binding.name || 'general'})</li>{/each}</ul>{/if}
      {/if}

      {#if error}<p class="error banner" role="alert">{error}</p>{/if}
      {#if issueList.length > 0}<ul class="error-list">{#each issueList as issue, index (`${index}-${issue}`)}<li>{issue}</li>{/each}</ul>{/if}
      <div class="wizard-actions">
        {#if step > 0}<button class="secondary" type="button" disabled={pending} onclick={() => { error = ''; step -= 1; }}>Back</button>{/if}
        {#if step < steps.length - 1}<button type="button" onclick={next}>Next</button>{:else}<button type="button" disabled={pending} onclick={() => void create()}>{pending ? 'Creating…' : 'Create configuration'}</button>{/if}
      </div>
    </div>
  </section>
{/if}
