import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['node_modules/**', '**/dist/**', 'scripts/probes/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,

      // The AI/provenance boundary is enforced by types (ADR-005). `any` erases exactly the
      // distinctions that enforcement rests on, so it is an error here, not a warning.
      '@typescript-eslint/no-explicit-any': 'error',

      // Raw source content must never reach logs (INV-12). console.* in service code is the
      // usual way it gets there. Probe scripts are ignored above; they log by design.
      'no-console': 'error',

      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/tests/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // CI verification scripts: Node CLI tools whose entire output contract is stdout/stderr plus
    // an exit code, so `console` and `process` are the interface, not a leak.
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
];
