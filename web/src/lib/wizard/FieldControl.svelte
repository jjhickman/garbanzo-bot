<script lang="ts">
  import type { WizardField } from '../api.js';

  let {
    field,
    value,
    options = [],
    issue = '',
    onChange,
  }: {
    field: WizardField;
    value: string;
    options?: string[];
    issue?: string;
    onChange: (value: string) => void;
  } = $props();

  const label = $derived(field.env
    .toLowerCase()
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' '));
  const booleanField = $derived(field.default === 'true'
    || field.default === 'false'
    || field.env.endsWith('_ENABLED')
    || field.env.endsWith('_SET_PROFILE_NAME'));
</script>

<div class="field" data-field={field.env}>
  {#if booleanField}
    <label class="toggle" for={field.env}>
      <input
        id={field.env}
        name={field.env}
        type="checkbox"
        checked={value === 'true'}
        onchange={(event) => onChange(String(event.currentTarget.checked))}
      />
      <span>{label}</span>
    </label>
  {:else}
    <label for={field.env}>{label}</label>
    {#if options.length > 0}
      <select
        id={field.env}
        name={field.env}
        value={value}
        aria-invalid={issue ? 'true' : 'false'}
        onchange={(event) => onChange(event.currentTarget.value)}
      >
        {#each options as option (option)}<option value={option}>{option}</option>{/each}
      </select>
    {:else}
      <input
        id={field.env}
        name={field.env}
        type={field.secret ? 'password' : 'text'}
        value={value}
        placeholder={field.secret ? `Enter ${label.toLowerCase()}` : field.default}
        autocomplete={field.secret ? 'new-password' : 'off'}
        aria-invalid={issue ? 'true' : 'false'}
        oninput={(event) => onChange(event.currentTarget.value)}
      />
    {/if}
  {/if}
  {#if field.note}<p class="field-help">{field.note}</p>{/if}
  {#if issue}<p class="error" role="alert">{issue}</p>{/if}
</div>
