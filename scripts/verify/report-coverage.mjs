#!/usr/bin/env node
/**
 * Coverage reporter (TDD.md §57(12): "CI reports test count and coverage/diff changes").
 *
 * Reads the `json-summary` reporter's output (vitest.config.ts's `coverage.reporter`), which the
 * `Tests` CI step produces by running with `--coverage`. Test COUNT is already asserted
 * independently by scripts/verify/assert-tests-ran.mjs; this script covers the other half of
 * §57(12) -- reporting coverage, and how it changed.
 *
 * CORRECTED after GPT-PM's round-1 review of this remediation: the first version reported only the
 * current run's numbers and explicitly declined to compare against the base commit, reasoning that
 * doing so honestly would need re-running the whole suite on the base commit too. GPT-PM's finding:
 * "no threshold required, reporting the change is sufficient" -- which does not need a second full
 * test run. `ci.yml` now caches each run's `coverage-summary.json` under a key derived from that
 * commit's own SHA (`actions/cache/save`, unconditional) and, for a pull_request build, additionally
 * restores whatever was cached under the PR's BASE SHA (`actions/cache/restore`, best-effort). This
 * script reads that restored file if present and reports a genuine base-vs-head delta; if no cache
 * entry exists for the base commit (the very first run after this shipped, or a cache eviction), it
 * says so honestly rather than fabricating a comparison.
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
 * @param {{lines:number,statements:number,branches:number,functions:number}} base
 * @param {{lines:number,statements:number,branches:number,functions:number}} head
 * @returns {string}
 */
export function formatDelta(base, head) {
  const row = (label, key) => {
    const d = head[key] - base[key];
    const sign = d >= 0 ? '+' : '';
    return `${label.padEnd(11)} ${sign}${d.toFixed(2)}pp (base ${base[key].toFixed(2)}% -> head ${head[key].toFixed(2)}%)`;
  };
  return [
    'Coverage change (base -> head):',
    row('Lines', 'lines'),
    row('Statements', 'statements'),
    row('Branches', 'branches'),
    row('Functions', 'functions'),
  ].join('\n');
}

/**
 * @returns {0|1} process exit code
 */
export function run({
  summaryPath = 'coverage/coverage-summary.json',
  baseSummaryPath = '.coverage-baseline/coverage-summary.json',
  readFile,
  readBaseFile,
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

  // The base summary is best-effort (a cache entry that may not exist yet, or may have been
  // evicted) -- its absence is never a failure, only something to say plainly rather than paper
  // over with a fabricated comparison.
  let baseTotals = null;
  let deltaNote = null;
  try {
    baseTotals = readTotals(baseSummaryPath, readBaseFile);
  } catch (error) {
    deltaNote = `No coverage baseline available for the base commit (${error.message}).`;
  }

  let deltaReport = null;
  if (baseTotals) {
    deltaReport = formatDelta(baseTotals, totals);
    log(deltaReport);
  } else if (deltaNote) {
    log(deltaNote);
  }

  if (appendStepSummary) {
    try {
      let summary =
        `## Coverage\n\n| Metric | % |\n| --- | --- |\n` +
        `| Lines | ${totals.lines.toFixed(2)} |\n` +
        `| Statements | ${totals.statements.toFixed(2)} |\n` +
        `| Branches | ${totals.branches.toFixed(2)} |\n` +
        `| Functions | ${totals.functions.toFixed(2)} |\n`;
      if (baseTotals) {
        summary +=
          `\n### Change vs base\n\n| Metric | Base % | Head % | Delta (pp) |\n| --- | --- | --- | --- |\n` +
          ['lines', 'statements', 'branches', 'functions']
            .map((key) => {
              const d = totals[key] - baseTotals[key];
              const sign = d >= 0 ? '+' : '';
              return `| ${key[0].toUpperCase()}${key.slice(1)} | ${baseTotals[key].toFixed(2)} | ${totals[key].toFixed(2)} | ${sign}${d.toFixed(2)} |\n`;
            })
            .join('');
      } else if (deltaNote) {
        summary += `\n_${deltaNote}_\n`;
      }
      appendStepSummary(summary);
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
