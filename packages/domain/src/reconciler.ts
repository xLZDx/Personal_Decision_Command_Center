import type { D1Database } from '@cloudflare/workers-types';

import { reserveBudget } from './budget.js';

export interface ReconcileDispatchOptions {
  now: string;
  /** UTC day bucket for the budget counter, e.g. "2026-09-13". Caller-supplied so the domain
   *  function never derives "today" from a wall clock itself (testability). */
  day: string;
  cap: number;
  maxAttempts: number;
  batchSize: number;
}

export interface ReconcileDispatchResult {
  /** event_ids actually marked DISPATCHED this cycle -- the caller (services/ingest's scheduled
   *  handler) sends exactly these to the Cloudflare Queue, AFTER this call returns, never before:
   *  budget is reserved and the outbox row is marked DISPATCHED first, so an enqueue can never
   *  happen without a budget reservation backing it (the HARD_ZERO fix -- budget was previously
   *  checked only after enqueueing, which could not actually prevent going over budget). */
  dispatched: string[];
  /** True once this cycle stopped dispatching purely because the budget was exhausted, not
   *  because eligible candidates ran out. */
  budgetExhausted: boolean;
}

/**
 * Phase 2 of the ingest scheduled handler: the budget-gated dispatch loop (TDD §16.3/§35). Once
 * `reserveBudget` reports the cap reached, EVERY remaining fetched candidate is deferred this
 * cycle -- budget cost is uniform per dispatch, so there is no "find a cheaper one to squeeze in"
 * once the day's reservation is exhausted (HARD_ZERO, not a soft best-effort limit).
 */
export async function reconcileDispatch(
  db: D1Database,
  opts: ReconcileDispatchOptions,
): Promise<ReconcileDispatchResult> {
  const candidates = await db
    .prepare(
      `SELECT o.event_id
       FROM processing_outbox AS o
       JOIN ingest_events AS e ON e.event_id = o.event_id
       WHERE o.state <> 'CLOSED'
         AND o.next_attempt_at <= ?
         AND e.state IN ('ACCEPTED', 'RETRYABLE_FAILED')
         AND e.processing_attempt_count < ?
       ORDER BY o.next_attempt_at
       LIMIT ?`,
    )
    .bind(opts.now, opts.maxAttempts, opts.batchSize)
    .all<{ event_id: string }>();

  const dispatched: string[] = [];
  let budgetExhausted = false;

  // Both mutations below are fenced on the exact set of pre-dispatch-eligible states, never the
  // weaker `state <> 'CLOSED'` -- database review BLOCKER (G2): that weaker guard let two
  // overlapping `reconcileDispatch` invocations (a slow previous cron tick still running, a manual
  // re-trigger, a future multi-instance deployment) both match an already-DISPATCHED row -- one
  // double-dispatching the same event to the real Queue, the other clobbering a genuinely
  // DISPATCHED row back to BUDGET_DEFERRED. Restricting the WHERE clause to the eligible states
  // makes each UPDATE an atomic compare-and-swap: only the invocation that observes the row still
  // eligible at the moment ITS statement executes can ever change it (`result.meta.changes`
  // distinguishes "I won" from "someone else already moved this row").
  //
  // Accepted residual risk, not closed by this fix: a losing invocation may still have already
  // called `reserveBudget` for the row before losing the CAS race, wasting that day's budget slot.
  // This does not reproduce the BLOCKER's failure scenario (no duplicate Queue send, no state
  // corruption) and is bounded by `batchSize` per genuinely overlapping invocation -- an efficiency
  // loss against the 2500 hard ceiling, not a correctness violation. Closing it fully would require
  // claiming the row before reserving budget, which needs an intermediate schema state this gate's
  // migration does not have; deferred rather than redesigning the schema under this fix.
  const ELIGIBLE_STATES = "('PENDING', 'RETRY_PENDING', 'BUDGET_DEFERRED')";

  for (const { event_id: eventId } of candidates.results) {
    if (!budgetExhausted) {
      const reservation = await reserveBudget(db, { day: opts.day, cap: opts.cap });
      if (!reservation.reserved) budgetExhausted = true;
    }

    if (budgetExhausted) {
      await db
        .prepare(
          `UPDATE processing_outbox SET state = 'BUDGET_DEFERRED', updated_at = ?
           WHERE event_id = ? AND state IN ${ELIGIBLE_STATES}`,
        )
        .bind(opts.now, eventId)
        .run();
      continue;
    }

    const result = await db
      .prepare(
        `UPDATE processing_outbox SET state = 'DISPATCHED', dispatch_count = dispatch_count + 1,
           dispatched_at = ?, updated_at = ?
         WHERE event_id = ? AND state IN ${ELIGIBLE_STATES}`,
      )
      .bind(opts.now, opts.now, eventId)
      .run();
    if (result.meta.changes === 1) dispatched.push(eventId);
  }

  return { dispatched, budgetExhausted };
}
