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

  // The gate-scope guard. Its whole value is refusing things, so every mutation below makes it
  // refuse less -- which is exactly the direction a broken governance check fails in.
  {
    label: 'check-gate-scope.mjs: "*" crosses "/" again (packages/* would re-authorize subtrees)',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: "(ch) => (ch === '*' ? '[^/]*' : `\\\\${ch}`)",
    to: "(ch) => (ch === '*' ? '.*' : `\\\\${ch}`)",
  },
  {
    label: 'check-gate-scope.mjs: stop escaping regex metacharacters in a literal segment',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: "(ch) => (ch === '*' ? '[^/]*' : `\\\\${ch}`)",
    to: "(ch) => (ch === '*' ? '[^/]*' : ch)",
  },
  {
    label: 'check-gate-scope.mjs: drop the end anchor (a prefix match would authorize a suffix)',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: 'return new RegExp(`^${source}$`);',
    to: 'return new RegExp(`^${source}`);',
  },
  {
    label: 'check-gate-scope.mjs: drop the start anchor (any parent directory would authorize)',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: 'return new RegExp(`^${source}$`);',
    to: 'return new RegExp(`${source}$`);',
  },
  {
    label: 'check-gate-scope.mjs: ignore forbidden_paths entirely',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: '    const hit = forbiddenRe.find((f) => f.re.test(path));',
    to: '    const hit = forbiddenRe.slice(0, 0).find((f) => f.re.test(path));',
  },
  {
    label: 'check-gate-scope.mjs: accept an empty allowed_paths instead of refusing to evaluate',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: '  if (!Array.isArray(allowed) || allowed.length === 0) {',
    to: '  if (false) {',
  },
  {
    label: 'check-gate-scope.mjs: stop reporting an allow-everything manifest entry',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: "  const vacuous = allowed.filter((p) => p === '**');",
    to: '  const vacuous = [];',
  },
  {
    label: 'check-gate-scope.mjs: accept a duplicated allowed_paths key',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: '  if (headerIndexes.length > 1) {',
    to: '  if (false) {',
  },
  {
    label: 'check-gate-scope.mjs: accept flow style, which reads as an empty list',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: "  if (rest !== '' && !rest.startsWith('#')) {",
    to: '  if (false) {',
  },
  {
    // The real hazard, and the defect this guard was added to fix: any non-indented line ending
    // the block means a list item that lost its indent truncates the list silently. For
    // `forbidden_paths` that is zero enforcement, indistinguishable from "nothing is forbidden".
    label: 'check-gate-scope.mjs: end the block at ANY unindented line (silent list truncation)',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: '      if (/^[A-Za-z_][A-Za-z0-9_.-]*:/.test(line)) break;',
    to: '      if (true) break;',
  },
  {
    label: 'check-gate-scope.mjs: never end the block, so any multi-key manifest fails to parse',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: '      if (/^[A-Za-z_][A-Za-z0-9_.-]*:/.test(line)) break;',
    to: '      if (false) break;',
  },
  {
    label: 'check-gate-scope.mjs: return a present-but-empty list instead of rejecting it',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: '  if (items.length === 0) {',
    to: '  if (false) {',
  },
  {
    label: 'check-gate-scope.mjs: read an unquoted leading "*" as a pattern, not a YAML alias',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: "    if (value.startsWith('*')) {",
    to: '    if (false) {',
  },
  {
    label: 'check-gate-scope.mjs: drop the "&" half of the alias/anchor rejection',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: "    if (value.startsWith('&')) {",
    to: '    if (false) {',
  },
  {
    label: 'check-gate-scope.mjs: accept a block scalar as a pattern',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: '    if (/^[|>]/.test(value)) {',
    to: '    if (false) {',
  },

  // run(): the only part of this file CI executes. Its exit code IS the control -- a guard that
  // computes violations correctly and then exits 0 provides nothing at all.
  {
    label: 'check-gate-scope.mjs: run() exits 0 despite scope violations',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: '        `and a new GO.`,\n    );\n    return 1;',
    to: '        `and a new GO.`,\n    );\n    return 0;',
  },
  {
    label: 'check-gate-scope.mjs: run() proceeds with a missing required environment variable',
    file: 'scripts/verify/check-gate-scope.mjs',
    from:
      '      logError(`::error::${name} is not set; refusing to run a check that cannot be complete.`);\n' +
      '      return 1;',
    to:
      '      logError(`::error::${name} is not set; refusing to run a check that cannot be complete.`);\n' +
      '      return 0;',
  },
  {
    label: 'check-gate-scope.mjs: run() treats a failed git diff as a clean, empty diff',
    file: 'scripts/verify/check-gate-scope.mjs',
    from:
      '    logError(`::error::could not list the changed paths: ${error.message}`);\n' +
      '    return 1;',
    to:
      '    logError(`::error::could not list the changed paths: ${error.message}`);\n' +
      '    return 0;',
  },
  {
    label: 'check-gate-scope.mjs: drop -z, so git quotes and escapes unusual filenames',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: "['diff', '--name-only', '-z', `${baseSha}...${headSha}`]",
    to: "['diff', '--name-only', `${baseSha}...${headSha}`]",
  },
  {
    label: 'check-gate-scope.mjs: stop filtering empty entries out of the NUL-split path list',
    file: 'scripts/verify/check-gate-scope.mjs',
    from: "return out.split('\\0').filter((p) => p !== '');",
    to: "return out.split('\\0');",
  },

  // check-floor-scope.mjs and its mutations were removed with it: the "Gate: NONE" ungated path it
  // enforced was deleted as a G1 closure BLOCKER (self-modification hole -- see
  // governance/plans/G1_PREADOPTION_EVIDENCE.md). Nothing to mutate-test in its place; the
  // resolve-gate step it used to bypass is bash inside governance.yml, outside this harness's
  // reach, and is instead covered by tests/policy/floor-scope.test.mjs's static assertions plus a
  // real CI negative control on `control/g1-none-rejection`.

  // The test-deletion guard. It shipped blind to `.test.mjs` on BOTH of its halves at once, which
  // left every governance suite in this repository deletable in silence while the check printed
  // "no tests removed or skipped". The first two mutations below reintroduce exactly that defect,
  // once through the extension list and once through the pathspec alone -- separately, because a
  // single mutation covering both would not prove the two encodings are independently anchored.
  {
    label: 'check-test-deletion.mjs: narrow the extension list back to .test.ts only',
    file: 'scripts/verify/check-test-deletion.mjs',
    from: "export const TEST_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'];",
    to: "export const TEST_EXTENSIONS = ['ts'];",
  },
  {
    label:
      'check-test-deletion.mjs: ask git only for *.test.ts, so skip detection goes blind again',
    file: 'scripts/verify/check-test-deletion.mjs',
    from: "runGit(['diff', '-U0', range, '--', ...TEST_PATHSPECS]);",
    to: "runGit(['diff', '-U0', range, '--', '*.test.ts']);",
  },
  {
    label:
      'check-test-deletion.mjs: stop testing the rename SOURCE, so a rename out of the corpus passes',
    file: 'scripts/verify/check-test-deletion.mjs',
    from: 'const touchesTest = TEST_FILE.test(path) || (source !== undefined && TEST_FILE.test(source));',
    to: 'const touchesTest = TEST_FILE.test(path);',
  },
  {
    label: 'check-test-deletion.mjs: read a rename as one path field, desyncing every later record',
    file: 'scripts/verify/check-test-deletion.mjs',
    from: '      i += 2;\n      if (destination === undefined) break;',
    to: '      i += 1;\n      if (destination === undefined) break;',
  },
  {
    label: 'check-test-deletion.mjs: drop the xit/xdescribe half of the skip marker',
    file: 'scripts/verify/check-test-deletion.mjs',
    from: 'const SKIP_MARKER = /\\b(?:it|test|describe)\\.(?:skip|todo)\\b|\\bxit\\b|\\bxdescribe\\b/;',
    to: 'const SKIP_MARKER = /\\b(?:it|test|describe)\\.(?:skip|todo)\\b/;',
  },
  {
    label: 'check-test-deletion.mjs: run() exits 0 despite deleted or skipped tests',
    file: 'scripts/verify/check-test-deletion.mjs',
    from:
      "        'and record the decision in core/DECISION_LOG.md. Do not silently drop coverage.',\n" +
      '    );\n' +
      '    return 1;',
    to:
      "        'and record the decision in core/DECISION_LOG.md. Do not silently drop coverage.',\n" +
      '    );\n' +
      '    return 0;',
  },
  {
    label: 'check-test-deletion.mjs: run() exits 0 when the pull_request context is missing',
    file: 'scripts/verify/check-test-deletion.mjs',
    from:
      "    error('BASE_SHA and HEAD_SHA must be set (pull_request context).');\n" + '    return 1;',
    to:
      "    error('BASE_SHA and HEAD_SHA must be set (pull_request context).');\n" + '    return 0;',
  },
  {
    label: 'check-test-deletion.mjs: drop -z, so git quotes and escapes unusual filenames',
    file: 'scripts/verify/check-test-deletion.mjs',
    from: "runGit(['diff', '--name-status', '-z', range]);",
    to: "runGit(['diff', '--name-status', range]);",
  },

  // CODEOWNERS is the only control that actually enforces anything here (merge authority; CI is
  // detection), so dropping a path from it is the highest-consequence silent edit in the repo.
  // These mutate the data rather than code, which is exactly right: the guard IS the assertion.
  {
    label: 'CODEOWNERS: comment out /docs/architecture/, unprotecting the TDD and its errata',
    file: '.github/CODEOWNERS',
    from: '/docs/architecture/             @xLZDx',
    to: '# /docs/architecture/           @xLZDx',
  },
  {
    label: 'CODEOWNERS: drop /scripts/verify/, unprotecting the governance checks themselves',
    file: '.github/CODEOWNERS',
    from: '/scripts/verify/                @xLZDx',
    to: '',
  },
  {
    label: 'CODEOWNERS: leave an entry with no owner, which requires no review',
    file: '.github/CODEOWNERS',
    from: '/core/adr/                      @xLZDx',
    to: '/core/adr/',
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
