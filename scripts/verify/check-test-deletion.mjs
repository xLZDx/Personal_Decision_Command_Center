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

const baseSha = process.env.BASE_SHA;
const headSha = process.env.HEAD_SHA;

if (!baseSha || !headSha) {
  console.error('BASE_SHA and HEAD_SHA must be set (pull_request context).');
  process.exit(1);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

const TEST_FILE = /(^|\/)tests\/.*\.test\.ts$|\.test\.ts$/;

const nameStatus = git(['diff', '--name-status', `${baseSha}...${headSha}`]).trim();
const problems = [];

for (const line of nameStatus.split('\n').filter(Boolean)) {
  const [status, ...paths] = line.split('\t');
  const path = paths[paths.length - 1];
  if (!TEST_FILE.test(path)) continue;

  if (status === 'D') {
    problems.push(`deleted test file: ${path}`);
  } else if (status.startsWith('R')) {
    // A rename is fine on its own; it is listed so a rename used to hide a deletion is visible.
    console.log(`note: test file renamed -> ${path}`);
  }
}

// Newly skipped tests: a `.skip`/`.todo` added in this PR is a deletion that leaves the file in
// place, and would otherwise sail past a deleted-file check.
const diff = git(['diff', '-U0', `${baseSha}...${headSha}`, '--', '*.test.ts']);
for (const line of diff.split('\n')) {
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  if (/\b(it|test|describe)\.(skip|todo)\b/.test(line) || /\bxit\b|\bxdescribe\b/.test(line)) {
    problems.push(`newly skipped test: ${line.trim()}`);
  }
}

if (problems.length > 0) {
  console.error('Test-deletion guard tripped:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nIf this is intentional, state it explicitly in the PR body:\n' +
      '  TEST-DELETION-APPROVED: <reason + where the decision is recorded>\n' +
      'and record the decision in core/DECISION_LOG.md. Do not silently drop coverage.',
  );
  process.exit(1);
}

console.log('Test-deletion guard: no tests removed or skipped.');
