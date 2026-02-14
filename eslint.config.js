// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'data/', 'baileys_auth/'],
  },
  ...tseslint.configs.recommended,
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
);
