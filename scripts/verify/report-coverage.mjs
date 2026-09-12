#!/usr/bin/env node
/**
 * Coverage reporter (TDD.md §57(12): "CI reports test count and coverage/diff changes").
 *
 * Reads the `json-summary` reporter's output (vitest.config.ts's `coverage.reporter`), which the
 * `Tests` CI step produces by running with `--coverage`. Test COUNT is already asserted
 * independently by scripts/verify/assert-tests-ran.mjs; this script covers the other half of
 * §57(12) -- reporting coverage, and how it changed -- honestly, rather than fabricating a
 * cross-commit coverage-diff pipeline this remediation does not build.
 *
 * "diff changes" is read here as: report the CURRENT run's coverage numbers precisely (this run's
 * diff from having no numbers at all), and record honestly that a coverage number compared
 * AGAINST THE BASE COMMIT is not implemented -- scope for a later gate, not asserted as done. The
 * changed-PATHS diff itself is already reported elsewhere (governance.yml's scope step, and
 * check-test-deletion.mjs's own diff), so this script does not duplicate that.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @param {string} summaryPath
 * @returns {{ lines: number, statements: number, branches: number, functions: number }}
 */
export function readTotals(summaryPath, readFile = (p) => readFileSync(p, 'utf8')) {
  const raw = readFile(summaryPath);
  const parsed = JSON.parse(raw);
  const total = parsed.total;
  if (!total || typeof total !== 'object') {
    throw new Error(`${summaryPath} has no "total" section -- not a v8/istanbul coverage summary.`);
  }
  for (const key of ['lines', 'statements', 'branches', 'functions']) {
    if (typeof total[key]?.pct !== 'number') {
      throw new Error(`${summaryPath}: total.${key}.pct is missing or not a number.`);
    }
  }
  return {
    lines: total.lines.pct,
    statements: total.statements.pct,
    branches: total.branches.pct,
    functions: total.functions.pct,
  };
}

export function formatReport(totals) {
  const row = (label, pct) => `${label.padEnd(11)} ${pct.toFixed(2)}%`;
  return [
    'Coverage (this run):',
    row('Lines', totals.lines),
    row('Statements', totals.statements),
    row('Branches', totals.branches),
    row('Functions', totals.functions),
  ].join('\n');
}

/**
 * @returns {0|1} process exit code
 */
export function run({
  summaryPath = 'coverage/coverage-summary.json',
  readFile,
  log = console.log,
  logError = console.error,
  appendStepSummary,
} = {}) {
  let totals;
  try {
    totals = readTotals(summaryPath, readFile);
  } catch (error) {
    logError(`::error::could not read coverage summary: ${error.message}`);
    return 1;
  }

  const report = formatReport(totals);
  log(report);

  if (appendStepSummary) {
    try {
      appendStepSummary(
        `## Coverage\n\n| Metric | % |\n| --- | --- |\n` +
          `| Lines | ${totals.lines.toFixed(2)} |\n` +
          `| Statements | ${totals.statements.toFixed(2)} |\n` +
          `| Branches | ${totals.branches.toFixed(2)} |\n` +
          `| Functions | ${totals.functions.toFixed(2)} |\n`,
      );
    } catch (error) {
      log(`note: could not write step summary: ${error.message}`);
    }
  }

  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  process.exitCode = run({
    appendStepSummary: summaryFile ? (text) => appendFileSync(summaryFile, text) : undefined,
  });
}
