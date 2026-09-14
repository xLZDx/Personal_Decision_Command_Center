import { describe, expect, it } from 'vitest';

import {
  assertG9DatasetAdequacy,
  calibrateAutoAttachThreshold,
  evaluateShadow,
} from '../src/index.js';

describe('G9 shadow evaluation', () => {
  it('exposes accuracy, confusion and false-merge count', () => {
    const result = evaluateShadow([
      { id: '1', expected: 'AUTO_ATTACH', actual: 'AUTO_ATTACH' },
      { id: '2', expected: 'SEPARATE', actual: 'AUTO_ATTACH' },
      { id: '3', expected: 'UNKNOWN', actual: 'UNKNOWN' },
    ]);
    expect(result).toMatchObject({ total: 3, correct: 2, falseMergeCount: 1, accuracy: 0.6667 });
    expect(result.confusion['SEPARATE->AUTO_ATTACH']).toBe(1);
  });

  it('calibrates bounded thresholds and rejects invalid scores', () => {
    const points = calibrateAutoAttachThreshold([
      { score: 0.95, shouldAttach: true },
      { score: 0.91, shouldAttach: false },
      { score: 0.72, shouldAttach: true },
    ]);
    expect(points).toHaveLength(4);
    expect(points.find((point) => point.threshold === 0.95)?.falseMergeRate).toBe(0);
    expect(() => calibrateAutoAttachThreshold([{ score: 2, shouldAttach: true }])).toThrow();
    expect(() =>
      calibrateAutoAttachThreshold([{ score: 0.9, shouldAttach: 'yes' as never }]),
    ).toThrow();
    expect(() =>
      evaluateShadow([{ id: 'raw text!', expected: 'UNKNOWN', actual: 'UNKNOWN' }]),
    ).toThrow();
    expect(() =>
      evaluateShadow([
        { id: 'dup', expected: 'UNKNOWN', actual: 'UNKNOWN' },
        { id: 'dup', expected: 'UNKNOWN', actual: 'UNKNOWN' },
      ]),
    ).toThrow();
  });

  it('refuses to claim G9 coverage for an undersized or unbalanced corpus', () => {
    expect(() =>
      assertG9DatasetAdequacy({
        total: 3,
        crossSource: 0,
        decisionOrAction: 0,
        ambiguous: 0,
        crossProjectCollisions: 0,
      }),
    ).toThrow();
    expect(() =>
      assertG9DatasetAdequacy({
        total: 200,
        crossSource: 30,
        decisionOrAction: 30,
        ambiguous: 20,
        crossProjectCollisions: 10,
      }),
    ).not.toThrow();
    expect(() =>
      assertG9DatasetAdequacy({
        total: 200,
        crossSource: 201,
        decisionOrAction: 30,
        ambiguous: 20,
        crossProjectCollisions: 10,
      }),
    ).toThrow();
    expect(() =>
      assertG9DatasetAdequacy({
        total: Number.NaN,
        crossSource: 30,
        decisionOrAction: 30,
        ambiguous: 20,
        crossProjectCollisions: 10,
      }),
    ).toThrow();
  });
});
