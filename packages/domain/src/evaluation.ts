import { z } from 'zod';

const Label = z.enum(['AUTO_ATTACH', 'CANDIDATE_MERGE', 'SEPARATE', 'UNKNOWN']);
const Prediction = z
  .object({ id: z.string().min(1).max(256), expected: Label, actual: Label })
  .strict();
export type ShadowPrediction = z.infer<typeof Prediction>;

export interface ShadowEvaluation {
  total: number;
  correct: number;
  accuracy: number;
  falseMergeCount: number;
  confusion: Readonly<Record<string, number>>;
}

export function evaluateShadow(predictions: readonly ShadowPrediction[]): ShadowEvaluation {
  const values = predictions.map((item) => Prediction.parse(item));
  const confusion: Record<string, number> = {};
  let correct = 0;
  let falseMergeCount = 0;
  for (const value of values) {
    const key = `${value.expected}->${value.actual}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
    if (value.expected === value.actual) correct += 1;
    if (value.expected !== 'AUTO_ATTACH' && value.actual === 'AUTO_ATTACH') falseMergeCount += 1;
  }
  return {
    total: values.length,
    correct,
    accuracy: values.length === 0 ? 0 : Number((correct / values.length).toFixed(4)),
    falseMergeCount,
    confusion,
  };
}

export interface CalibrationPoint {
  threshold: number;
  falseMergeRate: number;
  autoAttachRate: number;
}

/** Calculates threshold trade-offs without changing resolver behavior or reading source bodies. */
export function calibrateAutoAttachThreshold(
  scores: readonly { score: number; shouldAttach: boolean }[],
): CalibrationPoint[] {
  const bounded = scores.map((item) => {
    if (!Number.isFinite(item.score) || item.score < 0 || item.score > 1)
      throw new Error('score must be between 0 and 1');
    return item;
  });
  return [0.7, 0.8, 0.9, 0.95].map((threshold) => {
    const attached = bounded.filter((item) => item.score >= threshold);
    const falseMerges = attached.filter((item) => !item.shouldAttach).length;
    return {
      threshold,
      falseMergeRate:
        attached.length === 0 ? 0 : Number((falseMerges / attached.length).toFixed(4)),
      autoAttachRate:
        bounded.length === 0 ? 0 : Number((attached.length / bounded.length).toFixed(4)),
    };
  });
}
