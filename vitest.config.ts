import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/tests/**/*.test.ts',
      'services/**/tests/**/*.test.ts',
      'connectors/**/tests/**/*.test.ts',
      'host/**/tests/**/*.test.ts',
      'tests/**/*.test.ts',
      // The CI verification scripts are .mjs -- they run under bare node, before any build step
      // and without npm ci, so a broken dependency tree cannot disable a governance check. Their
      // tests are .mjs for the same reason. `tsc` does not typecheck .mjs; `tests/**/*.ts` IS in
      // tsconfig's include, so a .ts test placed here is still typechecked.
      'tests/**/*.test.mjs',
    ],
    // Fail rather than silently pass when a glob matches nothing. A suite that runs zero tests
    // and reports success is the failure mode that makes every other guarantee here worthless
    // (global CLAUDE.md: "a broken instrument imitates the result you wanted").
    passWithNoTests: false,
  },
});
