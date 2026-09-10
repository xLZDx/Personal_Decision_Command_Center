#!/usr/bin/env node
/**
 * Mutation check for the guards this repository's invariants actually rest on.
 *
 * A passing test suite is a claim, not evidence (core/DEFINITION_OF_DONE.md; TDD 67). This script
 * turns the claim into a measurement: for each mutation it breaks one guard in the real source,
 * runs the suite, and requires the suite to FAIL. A mutation that survives means the guard it
 * broke is not actually tested -- the test passes for some other reason and would keep passing if
 * the protection were deleted.
 *
 * Not wired into the default CI path: each mutation costs a full suite run. Run it when adding or
 * changing a guard, and at gate closure. `npm run verify:mutation`.
 *
 * Adding a mutation: the anchor must match EXACTLY ONCE. An anchor that matches nothing silently
 * "passes" by never applying the mutation, which is the same vacuous-evidence failure this script
 * exists to catch -- so a missing or ambiguous anchor is reported as a survivor, not skipped.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Resolve vitest's own JS entry point and run it with `node` directly.
 *
 * Not `npx`/`node_modules/.bin/vitest`: on Windows both are `.cmd` shims, and since the fix for
 * CVE-2024-27980 Node refuses to spawn a `.cmd` without `shell: true`. Going through a shell
 * instead trades that for arg-concatenation (Node warns about it as an injection vector), so the
 * clean answer is to skip the shim entirely. Resolving via `require.resolve` rather than a
 * hardcoded path keeps this working under npm workspace hoisting.
 */
const require = createRequire(import.meta.url);
const VITEST_ENTRY = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');

/** @type {{label: string, file: string, from: string, to: string}[]} */
const MUTATIONS = [
  {
    label: 'event.ts: drop .strict() from the envelope (raw body would flow through)',
    file: 'packages/contracts/src/event.ts',
    from: '    schema_version: z.literal(SCHEMA_VERSION),\n  })\n  .strict();',
    to: '    schema_version: z.literal(SCHEMA_VERSION),\n  });',
  },
  {
    label: 'event.ts: telegram guard inspects only routing_hints[0]',
    file: 'packages/contracts/src/event.ts',
    from: '  event.routing_hints.forEach((hint, index) => {',
    to: '  event.routing_hints.slice(0, 1).forEach((hint, index) => {',
  },
  {
    label: 'event.ts: telegram guard applies to every source (the Gmail control must break)',
    file: 'packages/contracts/src/event.ts',
    from: "  if (event.source !== 'telegram') return;",
    to: '  if (false) return;',
  },
  {
    label: 'event.ts: idempotencyKey joins with a space instead of length prefixes',
    file: 'packages/contracts/src/event.ts',
    from: "    .map((part) => `${part.length}:${part}`)\n    .join('');",
    to: "    .join(' ');",
  },
  {
    label: 'queue.ts: drop .strict() from PushPayload (push stops being opaque)',
    file: 'packages/contracts/src/queue.ts',
    from: '    schema_version: z.literal(PUSH_SCHEMA_VERSION),\n  })\n  .strict();',
    to: '    schema_version: z.literal(PUSH_SCHEMA_VERSION),\n  });',
  },
  {
    label: 'queue.ts: drop .strict() from QueuePayload (content could ride the queue)',
    file: 'packages/contracts/src/queue.ts',
    from: '    schema_version: z.literal(SCHEMA_VERSION),\n  })\n  .strict();',
    to: '    schema_version: z.literal(SCHEMA_VERSION),\n  });',
  },
  {
    label: 'provenance.ts: allow empty provenance ancestry (fail-open)',
    file: 'packages/contracts/src/provenance.ts',
    from: '    provenance: z.array(z.string().min(1)).min(1),',
    to: '    provenance: z.array(z.string().min(1)),',
  },
];

function suitePasses() {
  try {
    execFileSync(process.execPath, [VITEST_ENTRY, 'run', '--reporter=dot'], {
      cwd: REPO,
      stdio: 'ignore',
      maxBuffer: 32 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

if (!suitePasses()) {
  console.error('BASELINE FAILS -- fix the suite before mutation-testing it.');
  process.exit(2);
}
console.log('baseline: green\n');

const survivors = [];

for (const { label, file, from, to } of MUTATIONS) {
  const path = join(REPO, file);
  const original = readFileSync(path, 'utf8');
  const occurrences = original.split(from).length - 1;

  if (occurrences !== 1) {
    // Report, never skip: an anchor that no longer matches is usually a refactor that also moved
    // the guard, and treating it as "nothing to test" is how a guard quietly loses its coverage.
    console.log(
      `ANCHOR ${occurrences === 0 ? 'MISSING' : `AMBIGUOUS (${occurrences}x)`}  ${label}`,
    );
    survivors.push(`${label} [anchor matched ${occurrences} times -- mutation never applied]`);
    continue;
  }

  writeFileSync(path, original.replace(from, to), 'utf8');
  let stillGreen;
  try {
    stillGreen = suitePasses();
  } finally {
    writeFileSync(path, original, 'utf8');
  }

  if (stillGreen) {
    console.log(`SURVIVED  ${label}`);
    survivors.push(label);
  } else {
    console.log(`killed    ${label}`);
  }
}

console.log();
if (survivors.length > 0) {
  console.error(`${survivors.length} SURVIVOR(S) -- these guards are not actually tested:`);
  for (const s of survivors) console.error(`  - ${s}`);
  process.exit(1);
}
console.log(`all ${MUTATIONS.length} mutations killed`);
