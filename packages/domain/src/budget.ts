import type { D1Database } from '@cloudflare/workers-types';

/** The schema's own absolute, non-configurable ceiling (`queue_budget_counters`'s CHECK). The
 *  actual EFFECTIVE per-day cap enforced by a given reservation is a separate runtime value that
 *  may be set lower than this without a schema change (TDD's "configurable downward without
 *  review" rule) -- never higher. */
export const HARD_BUDGET_CEILING = 2500;

export interface ReserveBudgetOptions {
  day: string;
  cap: number;
}

export interface ReserveBudgetResult {
  reserved: boolean;
  dispatchedCount: number | null;
}

/**
 * Atomic, self-bootstrapping budget reservation: no manual day-boundary reset job exists or is
 * needed. `INSERT ... ON CONFLICT DO UPDATE ... WHERE dispatched_count < cap RETURNING` is a single
 * statement -- SQLite's own UPSERT semantics make the `WHERE` clause on the DO UPDATE branch a
 * no-op (zero rows, zero effect) when it does not match, rather than an error, so "the day row
 * doesn't exist yet" and "the day is genuinely at cap" are the only two branches, and only the
 * second one returns zero rows.
 */
export async function reserveBudget(
  db: D1Database,
  opts: ReserveBudgetOptions,
): Promise<ReserveBudgetResult> {
  if (!Number.isInteger(opts.cap) || opts.cap < 1 || opts.cap > HARD_BUDGET_CEILING) {
    throw new RangeError(
      `Budget cap must be an integer in [1, ${HARD_BUDGET_CEILING}], got ${opts.cap}`,
    );
  }
  const row = await db
    .prepare(
      `INSERT INTO queue_budget_counters (day, dispatched_count) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET dispatched_count = dispatched_count + 1
         WHERE dispatched_count < ?
       RETURNING dispatched_count`,
    )
    .bind(opts.day, opts.cap)
    .first<{ dispatched_count: number }>();

  if (!row) return { reserved: false, dispatchedCount: null };
  return { reserved: true, dispatchedCount: row.dispatched_count };
}
