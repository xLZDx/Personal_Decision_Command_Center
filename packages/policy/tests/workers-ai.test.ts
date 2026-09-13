import { describe, expect, it } from 'vitest';
import {
  WORKERS_AI_MAX_ESTIMATED_NEURONS_PER_CALL,
  WORKERS_AI_MAX_REQUEST_UTF8_BYTES,
  WORKERS_AI_TEMPLATE_TOKEN_OVERHEAD,
  assertWorkersAiRequestSize,
  estimateWorkersAiNeurons,
  workersAiNeuronsFromUsage,
} from '../src/index.js';

describe('Workers AI HARD_ZERO policy', () => {
  it('computes a deterministic ceiling for a maximum-size request', () => {
    expect(WORKERS_AI_TEMPLATE_TOKEN_OVERHEAD).toBeGreaterThan(0);
    expect(WORKERS_AI_MAX_ESTIMATED_NEURONS_PER_CALL).toBe(482);
    expect(estimateWorkersAiNeurons(WORKERS_AI_MAX_REQUEST_UTF8_BYTES)).toBe(
      WORKERS_AI_MAX_ESTIMATED_NEURONS_PER_CALL,
    );
  });

  it('is monotonic in serialized request size', () => {
    const estimates = [1, 100, 1_000, 8_000, WORKERS_AI_MAX_REQUEST_UTF8_BYTES].map(
      estimateWorkersAiNeurons,
    );
    expect(estimates).toEqual([...estimates].sort((a, b) => a - b));
    expect(estimates.at(-1)).toBe(WORKERS_AI_MAX_ESTIMATED_NEURONS_PER_CALL);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid serialized request size %s',
    (requestUtf8Bytes) => {
      expect(() => assertWorkersAiRequestSize(requestUtf8Bytes)).toThrow(RangeError);
    },
  );

  it('rejects an oversized request before it can consume quota', () => {
    expect(() => estimateWorkersAiNeurons(WORKERS_AI_MAX_REQUEST_UTF8_BYTES + 1)).toThrow(
      /requestUtf8Bytes/,
    );
  });

  it('rounds complete reported usage upward using conservative rates', () => {
    expect(workersAiNeuronsFromUsage({ promptTokens: 1_000, completionTokens: 100 })).toBe(34);
    expect(workersAiNeuronsFromUsage({ promptTokens: 0, completionTokens: 0 })).toBe(0);
  });

  it.each([
    { promptTokens: -1, completionTokens: 0 },
    { promptTokens: 0.5, completionTokens: 0 },
    { promptTokens: 0, completionTokens: Number.NaN },
  ])('rejects malformed provider usage %#', (usage) => {
    expect(() => workersAiNeuronsFromUsage(usage)).toThrow(RangeError);
  });
});
