import { describe, expect, it, vi } from 'vitest';

import { formatReport, readTotals, run } from '../../scripts/verify/report-coverage.mjs';

const VALID_SUMMARY = JSON.stringify({
  total: {
    lines: { pct: 87.5 },
    statements: { pct: 86.1 },
    branches: { pct: 72.3 },
    functions: { pct: 90 },
  },
});

describe('readTotals', () => {
  it('extracts the four percentages from a valid summary', () => {
    const totals = readTotals('coverage/coverage-summary.json', () => VALID_SUMMARY);
    expect(totals).toEqual({ lines: 87.5, statements: 86.1, branches: 72.3, functions: 90 });
  });

  it('rejects a file with no total section', () => {
    expect(() => readTotals('x.json', () => JSON.stringify({ foo: 'bar' }))).toThrow(/no "total"/);
  });

  it('rejects a total section missing one of the four metrics', () => {
    const bad = JSON.stringify({
      total: { lines: { pct: 90 }, statements: { pct: 90 }, branches: { pct: 90 } },
    });
    expect(() => readTotals('x.json', () => bad)).toThrow(/functions\.pct/);
  });
});

describe('formatReport', () => {
  it('renders all four metrics as percentages', () => {
    const report = formatReport({ lines: 87.5, statements: 86.1, branches: 72.3, functions: 90 });
    expect(report).toContain('Lines');
    expect(report).toContain('87.50%');
    expect(report).toContain('Functions');
    expect(report).toContain('90.00%');
  });
});

describe('run', () => {
  it('returns 0 and logs the report on a valid summary', () => {
    const log = vi.fn();
    const code = run({ readFile: () => VALID_SUMMARY, log });
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Coverage (this run):'));
  });

  it('returns 1 and logs an error when the summary cannot be read', () => {
    const logError = vi.fn();
    const code = run({
      readFile: () => {
        throw new Error('ENOENT');
      },
      logError,
    });
    expect(code).toBe(1);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('::error::'));
  });

  it('writes a step summary when a writer is supplied, and does not fail the run if it throws', () => {
    const appendStepSummary = vi.fn();
    const code = run({ readFile: () => VALID_SUMMARY, log: vi.fn(), appendStepSummary });
    expect(code).toBe(0);
    expect(appendStepSummary).toHaveBeenCalledWith(expect.stringContaining('## Coverage'));

    const throwingWriter = vi.fn(() => {
      throw new Error('disk full');
    });
    const code2 = run({
      readFile: () => VALID_SUMMARY,
      log: vi.fn(),
      appendStepSummary: throwingWriter,
    });
    expect(code2).toBe(0);
  });
});
