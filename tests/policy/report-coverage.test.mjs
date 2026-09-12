import { describe, expect, it, vi } from 'vitest';

import {
  formatDelta,
  formatReport,
  readTotals,
  run,
} from '../../scripts/verify/report-coverage.mjs';

const VALID_SUMMARY = JSON.stringify({
  total: {
    lines: { pct: 87.5 },
    statements: { pct: 86.1 },
    branches: { pct: 72.3 },
    functions: { pct: 90 },
  },
});

const BASE_SUMMARY = JSON.stringify({
  total: {
    lines: { pct: 80.0 },
    statements: { pct: 80.0 },
    branches: { pct: 70.0 },
    functions: { pct: 95 },
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

describe('formatDelta', () => {
  it('reports a positive delta when head coverage is higher than base', () => {
    const delta = formatDelta(
      { lines: 80, statements: 80, branches: 70, functions: 95 },
      { lines: 87.5, statements: 86.1, branches: 72.3, functions: 90 },
    );
    expect(delta).toContain('+7.50pp');
    expect(delta).toContain('base 80.00%');
    expect(delta).toContain('head 87.50%');
  });

  it('reports a negative delta when head coverage regresses vs base', () => {
    const delta = formatDelta(
      { lines: 80, statements: 80, branches: 70, functions: 95 },
      { lines: 87.5, statements: 86.1, branches: 72.3, functions: 90 },
    );
    expect(delta).toContain('-5.00pp');
  });

  it('changes output when base and head coverage differ (the finding this closes)', () => {
    const noChange = formatDelta(
      { lines: 87.5, statements: 86.1, branches: 72.3, functions: 90 },
      { lines: 87.5, statements: 86.1, branches: 72.3, functions: 90 },
    );
    const withChange = formatDelta(
      { lines: 80, statements: 80, branches: 70, functions: 95 },
      { lines: 87.5, statements: 86.1, branches: 72.3, functions: 90 },
    );
    expect(noChange).not.toEqual(withChange);
    expect(noChange).toContain('+0.00pp');
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

  it('reports a base-vs-head delta when a cached baseline summary is present', () => {
    const log = vi.fn();
    const code = run({
      readFile: () => VALID_SUMMARY,
      readBaseFile: () => BASE_SUMMARY,
      log,
    });
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Coverage change (base -> head):'));
  });

  it('includes the delta table in the step summary when a baseline is present', () => {
    const appendStepSummary = vi.fn();
    const code = run({
      readFile: () => VALID_SUMMARY,
      readBaseFile: () => BASE_SUMMARY,
      log: vi.fn(),
      appendStepSummary,
    });
    expect(code).toBe(0);
    expect(appendStepSummary).toHaveBeenCalledWith(expect.stringContaining('Change vs base'));
  });

  it('says plainly, without failing, when no baseline is available for the base commit', () => {
    const log = vi.fn();
    const code = run({
      readFile: () => VALID_SUMMARY,
      readBaseFile: () => {
        throw new Error('ENOENT: no such file');
      },
      log,
    });
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no coverage baseline available/i));
  });

  it('does not report a delta when the baseline cannot be read', () => {
    const log = vi.fn();
    run({
      readFile: () => VALID_SUMMARY,
      readBaseFile: () => {
        throw new Error('ENOENT');
      },
      log,
    });
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining('Coverage change (base -> head):'),
    );
  });
});
