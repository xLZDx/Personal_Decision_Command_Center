import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/tests/**/*.test.ts',
      'services/**/tests/**/*.test.ts',
      'connectors/**/tests/**/*.test.ts',
      'host/**/tests/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    // Fail rather than silently pass when a glob matches nothing. A suite that runs zero tests
    // and reports success is the failure mode that makes every other guarantee here worthless
    // (global CLAUDE.md: "a broken instrument imitates the result you wanted").
    passWithNoTests: false,
  },
});
