import { z } from 'zod';

const Label = z.enum(['AUTO_ATTACH', 'CANDIDATE_MERGE', 'SEPARATE', 'UNKNOWN']);
const OpaqueId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const Prediction = z.object({ id: OpaqueId, expected: Label, actual: Label }).strict();
const MAX_SHADOW_ROWS = 10_000;
export type ShadowPrediction = z.infer<typeof Prediction>;

export interface ShadowEvaluation {
  total: number;
  correct: number;
  accuracy: number;
  falseMergeCount: number;
  confusion: Readonly<Record<string, number>>;
}

export function evaluateShadow(predictions: readonly ShadowPrediction[]): ShadowEvaluation {
  if (predictions.length > MAX_SHADOW_ROWS) throw new Error('shadow dataset exceeds size cap');
  const values = predictions.map((item) => Prediction.parse(item));
  if (new Set(values.map((item) => item.id)).size !== values.length) {
    throw new Error('shadow dataset contains duplicate ids');
  }
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

export interface G9DatasetCounts {
  total: number;
  crossSource: number;
  decisionOrAction: number;
  ambiguous: number;
  crossProjectCollisions: number;
}

const DatasetCountsSchema = z
  .object({
    total: z.number().int().nonnegative().max(MAX_SHADOW_ROWS),
    crossSource: z.number().int().nonnegative(),
    decisionOrAction: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
    crossProjectCollisions: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const key of [
      'crossSource',
      'decisionOrAction',
      'ambiguous',
      'crossProjectCollisions',
    ] as const) {
      if (value[key] > value.total)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'count cannot exceed total',
        });
    }
  });

/** Enforces the minimum labeled corpus shape required before claiming a G9 exit metric. */
export function assertG9DatasetAdequacy(counts: G9DatasetCounts): void {
  const value = DatasetCountsSchema.parse(counts);
  if (
    value.total < 200 ||
    value.crossSource < 30 ||
    value.decisionOrAction < 30 ||
    value.ambiguous < 20 ||
    value.crossProjectCollisions < 10
  ) {
    throw new Error('G9 dataset does not meet minimum labeled coverage');
  }
}

/** Calculates threshold trade-offs without changing resolver behavior or reading source bodies. */
export function calibrateAutoAttachThreshold(
  scores: readonly { score: number; shouldAttach: boolean }[],
): CalibrationPoint[] {
  if (scores.length > MAX_SHADOW_ROWS) throw new Error('calibration dataset exceeds size cap');
  const bounded = scores.map((item) => {
    if (!Number.isFinite(item.score) || item.score < 0 || item.score > 1)
      throw new Error('score must be between 0 and 1');
    if (typeof item.shouldAttach !== 'boolean') throw new Error('shouldAttach must be boolean');
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
