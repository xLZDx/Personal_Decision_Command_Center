import { z } from 'zod';

export const OperationalSnapshotSchema = z
  .object({
    capturedAt: z.string().datetime({ offset: true }),
    telegramListener: z.enum(['UP', 'DOWN', 'DEGRADED']),
    gmailCollector: z.enum(['UP', 'DOWN', 'DEGRADED']),
    acceptedEvents: z.number().int().nonnegative(),
    unprocessedEvents: z.number().int().nonnegative(),
    recoveredLeases: z.number().int().nonnegative(),
    restrictedProvenanceTouches: z.number().int().nonnegative(),
    queueBudgetRemaining: z.number().int().nonnegative(),
  })
  .strict();

export type OperationalSnapshot = z.infer<typeof OperationalSnapshotSchema>;

export function validateOperationalSnapshot(input: unknown): OperationalSnapshot {
  return OperationalSnapshotSchema.parse(input);
}

export function shouldRetainRecord(createdAt: string, now: string, retentionDays: number): boolean {
  if (!Number.isInteger(retentionDays) || retentionDays < 1)
    throw new Error('retentionDays must be positive');
  const created = Date.parse(createdAt);
  const current = Date.parse(now);
  if (!Number.isFinite(created) || !Number.isFinite(current))
    throw new Error('invalid retention timestamp');
  return current - created < retentionDays * 24 * 60 * 60 * 1000;
}
