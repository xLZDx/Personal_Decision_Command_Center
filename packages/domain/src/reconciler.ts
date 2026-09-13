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
  /**
   * How long a DISPATCHED outbox row may sit unclaimed before it is treated as a lost/expired
   * Queue message and becomes eligible for redispatch (GPT-PM BLOCKER, G2 gate review: the
   * approved architecture requires "a due DISPATCHED row whose Queue message vanished must
   * re-enter dispatch," and ADR-006 requires simulated >24h Queue expiry to be recoverable purely
   * from D1). Must stay well above the Queue's own normal delivery/consumption latency -- too
   * short redispatches a message that is merely queued but not yet consumed, wasting budget and
   * creating a real (CAS-safe, but still wasteful) duplicate delivery.
   */
  redispatchTimeoutMs: number;
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
  // `o.dispatch_count` is carried through as the optimistic-lock value the redispatch CAS below
  // fences on. Candidates already include DISPATCHED rows (state <> 'CLOSED') -- that is what
  // makes a due-but-still-unclaimed dispatch (a lost/expired Queue message) reappear here at all;
  // `e.state IN ('ACCEPTED', 'RETRYABLE_FAILED')` already excludes any row a real claim has moved
  // to PROCESSING, so a currently-being-processed event is never mistaken for a lost dispatch.
  const candidates = await db
    .prepare(
      `SELECT o.event_id, o.dispatch_count
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
    .all<{ event_id: string; dispatch_count: number }>();

  const dispatched: string[] = [];
  let budgetExhausted = false;

  // Every mutation below is fenced on the exact set of pre-dispatch-eligible states, never the
  // weaker `state <> 'CLOSED'` -- database review BLOCKER (G2, checkpoint 3): that weaker guard let
  // two overlapping `reconcileDispatch` invocations (a slow previous cron tick still running, a
  // manual re-trigger, a future multi-instance deployment) both match an already-DISPATCHED row --
  // one double-dispatching the same event to the real Queue, the other clobbering a genuinely
  // DISPATCHED row back to BUDGET_DEFERRED.
  //
  // A SECOND, DISTINCT branch (`state = 'DISPATCHED' AND dispatch_count = ?`) is required alongside
  // the first -- GPT-PM BLOCKER, gate review round 1: the checkpoint-3 fence alone made a
  // DISPATCHED row's dispatch_count/next_attempt_at permanently frozen, so a genuinely lost Queue
  // message (send() succeeded but the message never reached a consumer, or expired unconsumed)
  // could NEVER be redispatched -- the event would sit ACCEPTED forever. This branch is the
  // redispatch CAS: it only matches a DISPATCHED row whose `dispatch_count` still equals the EXACT
  // value this call's own candidate SELECT observed, so a concurrent redispatch attempt (this same
  // event selected by two overlapping invocations, or one invocation's own stale local retry) can
  // only ever have ONE winner -- the loser's `dispatch_count` param no longer matches once the
  // winner's UPDATE has incremented it, so its own UPDATE changes zero rows, exactly like the first
  // branch's CAS already does for a fresh PENDING/RETRY_PENDING/BUDGET_DEFERRED dispatch.
  //
  // Every successful dispatch (fresh or redispatch) also advances `next_attempt_at` to
  // `now + redispatchTimeoutMs` -- previously left frozen at the row's pre-dispatch value, which
  // meant a DISPATCHED-but-not-yet-claimed row was ALSO a candidate on every subsequent tick
  // (`next_attempt_at <= now` stayed true forever), so even a single, non-overlapping
  // `reconcileDispatch` call would have kept re-sending the same still-pending message every cron
  // tick. Advancing it gives the Queue consumer a real grace window before this row is ever
  // reconsidered, and is what makes the redispatch branch above trigger only for a message that
  // has genuinely been unclaimed longer than `redispatchTimeoutMs`, not merely queued.
  for (const { event_id: eventId, dispatch_count: observedDispatchCount } of candidates.results) {
    if (!budgetExhausted) {
      const reservation = await reserveBudget(db, { day: opts.day, cap: opts.cap });
      if (!reservation.reserved) budgetExhausted = true;
    }

    if (budgetExhausted) {
      await db
        .prepare(
          `UPDATE processing_outbox SET state = 'BUDGET_DEFERRED', updated_at = ?
           WHERE event_id = ?
             AND (state IN ('PENDING', 'RETRY_PENDING', 'BUDGET_DEFERRED')
                  OR (state = 'DISPATCHED' AND dispatch_count = ?))`,
        )
        .bind(opts.now, eventId, observedDispatchCount)
        .run();
      continue;
    }

    const nextAttemptAt = new Date(Date.parse(opts.now) + opts.redispatchTimeoutMs).toISOString();
    const result = await db
      .prepare(
        `UPDATE processing_outbox SET state = 'DISPATCHED', dispatch_count = dispatch_count + 1,
           dispatched_at = ?, next_attempt_at = ?, updated_at = ?
         WHERE event_id = ?
           AND (state IN ('PENDING', 'RETRY_PENDING', 'BUDGET_DEFERRED')
                OR (state = 'DISPATCHED' AND dispatch_count = ?))`,
      )
      .bind(opts.now, nextAttemptAt, opts.now, eventId, observedDispatchCount)
      .run();
    if (result.meta.changes === 1) dispatched.push(eventId);
  }

  return { dispatched, budgetExhausted };
}
