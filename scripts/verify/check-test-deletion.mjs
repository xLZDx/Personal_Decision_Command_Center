#!/usr/bin/env node
/**
 * Test-deletion guard (TDD 57(11), 61).
 *
 * Flags a PR that removes, renames away, or skips tests. Deleting a test is sometimes correct --
 * the behavior it guarded was genuinely removed -- so this does not forbid it outright. It
 * requires the PR to say so explicitly, which turns a silent coverage loss into a reviewable
 * claim.
 *
 * To pass with an intentional deletion, include in the PR body (or in a commit message on the PR):
 *
 *     TEST-DELETION-APPROVED: <finding id or reason, plus where the decision is recorded>
 *
 * That string is checked for by the reviewer, not by this script -- the script's job is to make
 * the deletion impossible to miss.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * The extensions a test file may carry, and the ONLY place that list is written down.
 *
 * This guard shipped blind to `.test.mjs` on both of its halves at once: the file-status regex
 * matched `.test.ts` only, and the skip-detection diff was fetched with the pathspec `*.test.ts`.
 * At the time three of the repository's five test files -- `tests/policy/gate-scope.test.mjs`,
 * `floor-scope.test.mjs` and `codeowners.test.mjs`, i.e. every governance suite, the ones that
 * police the gate mechanism itself -- could have been deleted or skipped in a PR and this check
 * would have printed "no tests removed or skipped" and exited 0.
 *
 * The defect was not that someone wrote the wrong extension once. It was that the SAME rule was
 * encoded twice, in two syntaxes, with nothing tying them together -- so fixing one would leave
 * the other silently narrower. Both are now derived from this array, and a test asserts the
 * derivation covers every test file actually tracked in the repository, which is the check that
 * would have caught the original defect.
 */
export const TEST_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'];

/** Matches a path ending in `.test.<ext>` for any extension above. */
export const TEST_FILE = new RegExp(`\\.test\\.(?:${TEST_EXTENSIONS.join('|')})$`);

/** The same rule as `TEST_FILE`, in the syntax `git diff -- <pathspec>` speaks. */
export const TEST_PATHSPECS = TEST_EXTENSIONS.map((ext) => `*.test.${ext}`);

const SKIP_MARKER = /\b(?:it|test|describe)\.(?:skip|todo)\b|\bxit\b|\bxdescribe\b/;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/**
 * Split `git diff --name-status -z` output into `{ status, path }` records.
 *
 * `-z` rather than the default: git otherwise quotes and backslash-escapes unusual filenames, and
 * an escaped path would be matched against a pattern written in terms of the real one. Under `-z`
 * every field is its own NUL-terminated record, and a rename or copy carries TWO path fields --
 * source then destination -- so the fields cannot simply be read in pairs.
 *
 * The destination is the path reported, matching the previous behavior: for a rename it is what
 * the tree ends up with, and a rename AWAY from a test path shows up as a deletion of the source
 * only when git does not pair it, which is exactly when it matters.
 */
export function parseNameStatusZ(raw) {
  const fields = raw.split('\0').filter((f) => f !== '');
  const records = [];

  for (let i = 0; i < fields.length;) {
    const status = fields[i];
    i += 1;
    if (status.startsWith('R') || status.startsWith('C')) {
      const source = fields[i];
      const destination = fields[i + 1];
      i += 2;
      if (destination === undefined) break;
      records.push({ status, path: destination, source });
    } else {
      const path = fields[i];
      i += 1;
      if (path === undefined) break;
      records.push({ status, path });
    }
  }

  return records;
}

/**
 * The detection itself, over raw git output, with no process and no repository.
 *
 * @param {{ nameStatus: string, diff: string }} input
 * @returns {{ problems: string[], notes: string[] }}
 */
export function findProblems({ nameStatus, diff }) {
  const problems = [];
  const notes = [];

  for (const { status, path, source } of parseNameStatusZ(nameStatus)) {
    // A rename away from a test path is a deletion of coverage even when the destination is not a
    // test file any more, so the SOURCE is tested too -- otherwise `foo.test.mjs -> foo.mjs`
    // would pass unremarked.
    const touchesTest = TEST_FILE.test(path) || (source !== undefined && TEST_FILE.test(source));
    if (!touchesTest) continue;

    if (status === 'D') {
      problems.push(`deleted test file: ${path}`);
    } else if (status.startsWith('R')) {
      if (TEST_FILE.test(source) && !TEST_FILE.test(path)) {
        problems.push(`test file renamed out of the test corpus: ${source} -> ${path}`);
      } else {
        // A rename within the corpus is fine on its own; it is listed so a rename used to hide a
        // deletion is visible.
        notes.push(`test file renamed -> ${path}`);
      }
    }
  }

  // Newly skipped tests: a `.skip`/`.todo` added in this PR is a deletion that leaves the file in
  // place, and would otherwise sail past a deleted-file check.
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (SKIP_MARKER.test(line)) {
      problems.push(`newly skipped test: ${line.trim()}`);
    }
  }

  return { problems, notes };
}

/**
 * The whole CLI, as a function that RETURNS an exit code instead of calling process.exit.
 *
 * The guarantee this file exists to provide -- "CI fails the build when coverage is dropped
 * silently" -- IS the `return 1` below, so it lives here where a test can reach it, not in an
 * untestable `main()`. Dependencies are injected for the same reason: the exit paths can be
 * exercised without a git repository. This mirrors `check-gate-scope.mjs`, which was restructured
 * the same way after an internal review made exactly this point.
 *
 * @returns {0|1} process exit code
 */
export function run({
  env,
  cwd,
  runGit = (args) => git(args, cwd),
  log = console.log,
  error = console.error,
}) {
  const baseSha = env.BASE_SHA;
  const headSha = env.HEAD_SHA;

  if (!baseSha || !headSha) {
    error('BASE_SHA and HEAD_SHA must be set (pull_request context).');
    return 1;
  }

  const range = `${baseSha}...${headSha}`;
  const nameStatus = runGit(['diff', '--name-status', '-z', range]);
  const diff = runGit(['diff', '-U0', range, '--', ...TEST_PATHSPECS]);

  const { problems, notes } = findProblems({ nameStatus, diff });

  for (const note of notes) log(`note: ${note}`);

  if (problems.length > 0) {
    error('Test-deletion guard tripped:\n');
    for (const problem of problems) error(`  - ${problem}`);
    error(
      '\nIf this is intentional, state it explicitly in the PR body:\n' +
        '  TEST-DELETION-APPROVED: <reason + where the decision is recorded>\n' +
        'and record the decision in core/DECISION_LOG.md. Do not silently drop coverage.',
    );
    return 1;
  }

  log('Test-deletion guard: no tests removed or skipped.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `exitCode` rather than `exit()`: the latter can terminate the process before stdout has
  // flushed, which would drop the very annotations CI is meant to display.
  process.exitCode = run({ env: process.env, cwd: process.cwd() });
}
