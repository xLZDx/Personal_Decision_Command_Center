#!/usr/bin/env node
/**
 * Asserts the test suite actually executed tests, and that the count has not silently collapsed.
 *
 * Why this exists: a passing suite that ran zero tests reports success. Every other guarantee in
 * this repository -- the provenance boundary, push opacity, idempotency -- is asserted by tests,
 * so "the tests passed" is only meaningful if tests ran. A glob typo, a renamed directory or a
 * misconfigured `include` turns the whole suite into a no-op that CI reports green.
 *
 * MIN_TESTS is a floor, not a target. Raise it when a gate adds a body of tests; never lower it
 * to make a red build green -- that is the "weaken tests to obtain green" move CLAUDE.md 2
 * forbids, and lowering it is exactly as visible in a diff as deleting a test file.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const MIN_TESTS = 30;

// Run vitest's own JS entry with `node` rather than going through `npx`/`node_modules/.bin`:
// on Windows both are `.cmd` shims that Node refuses to spawn without `shell: true` (since the
// CVE-2024-27980 fix), and `shell: true` concatenates rather than escapes args, which Node warns
// about in turn. Skipping the shim avoids both. `require.resolve` keeps this correct under
// npm workspace hoisting.
const require = createRequire(import.meta.url);
const vitestEntry = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');

const raw = execFileSync(process.execPath, [vitestEntry, 'run', '--reporter=json'], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});

// vitest's json reporter writes the report to stdout, but other tooling can prepend noise.
const start = raw.indexOf('{');
if (start === -1) {
  console.error('Could not find a JSON report in vitest output.');
  process.exit(1);
}

const report = JSON.parse(raw.slice(start));
const total = report.numTotalTests ?? 0;
const passed = report.numPassedTests ?? 0;

if (total < MIN_TESTS) {
  console.error(
    `Test count collapsed: ${total} test(s) ran, expected at least ${MIN_TESTS}.\n` +
      'Either the suite is not being collected, or tests were removed. Both are blocking.',
  );
  process.exit(1);
}

if (passed !== total) {
  console.error(`${total - passed} test(s) did not pass.`);
  process.exit(1);
}

console.log(`Test count OK: ${passed}/${total} passed (floor ${MIN_TESTS}).`);
