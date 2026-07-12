// @ts-check
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';

export default tseslint.config(
  {
    ignores: ['dist/', 'web/dist/', 'node_modules/', 'data/', 'baileys_auth/'],
  },
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    rules: {
      // Allow unused vars prefixed with _ (common pattern for intentional ignores)
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      // We use non-null assertions intentionally in places where we know the value exists
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // Allow explicit any in rare cases (e.g., Baileys types)
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['web/**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
    rules: {
      'svelte/no-at-html-tags': 'error',
    },
  },
);
