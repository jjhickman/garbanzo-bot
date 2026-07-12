<script lang="ts">
  import type { WizardField } from '../api.js';

  let {
    field, value, secretSet, cleared, issue = '', options = [], onValue, onClear,
  }: {
    field: WizardField;
    value: string;
    secretSet: boolean;
    cleared: boolean;
    issue?: string;
    options?: string[];
    onValue: (value: string) => void;
    onClear: (cleared: boolean) => void;
  } = $props();

  const label = $derived(field.env.toLowerCase().split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' '));
  const booleanField = $derived(!field.secret && (field.default === 'true'
    || field.default === 'false'
    || field.env.endsWith('_ENABLED')
    || field.env.endsWith('_SET_PROFILE_NAME')));
</script>

<div class="field editor-field" data-field={field.env}>
  {#if field.secret}
    <div class="secret-heading">
      <label for={field.env}>{label}</label>
      <span class="secret-state">{secretSet && !cleared ? 'Set' : 'Not set'}</span>
    </div>
    <input
      id={field.env}
      name={field.env}
      type="password"
      {value}
      disabled={cleared}
      placeholder={secretSet ? 'Leave blank to keep' : 'Enter a new secret'}
      autocomplete="new-password"
      aria-invalid={issue ? 'true' : 'false'}
      oninput={(event) => onValue(event.currentTarget.value)}
    />
    <label class="clear-secret" for={`${field.env}-clear`}>
      <input
        id={`${field.env}-clear`}
        name={`${field.env}-clear`}
        type="checkbox"
        checked={cleared}
        onchange={(event) => onClear(event.currentTarget.checked)}
      />
      <span>Clear this secret</span>
    </label>
  {:else if booleanField}
    <label class="toggle" for={field.env}>
      <input id={field.env} name={field.env} type="checkbox" checked={value === 'true'} onchange={(event) => onValue(String(event.currentTarget.checked))} />
      <span>{label}</span>
    </label>
  {:else}
    <label for={field.env}>{label}</label>
    {#if options.length > 0}
      <select id={field.env} name={field.env} {value} aria-invalid={issue ? 'true' : 'false'} onchange={(event) => onValue(event.currentTarget.value)}>
        {#each options as option (option)}<option value={option}>{option}</option>{/each}
      </select>
    {:else}
      <input id={field.env} name={field.env} type="text" {value} placeholder={field.default} autocomplete="off" aria-invalid={issue ? 'true' : 'false'} oninput={(event) => onValue(event.currentTarget.value)} />
    {/if}
  {/if}
  {#if field.note}<p class="field-help">{field.note}</p>{/if}
  {#if issue}<p class="error" role="alert">{issue}</p>{/if}
</div>
