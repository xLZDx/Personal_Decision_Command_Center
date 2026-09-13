import type { D1Database } from '@cloudflare/workers-types';

/**
 * The compare-and-swap fence every mutation of a PROCESSING row must present (migration 0001's own
 * comment on `ingest_events.processing_lease_token`). `token` alone is what the live processor's
 * own claim/heartbeat/complete path uses -- it always acts on its own currently-valid, non-expired
 * lease by definition. `requireExpiredAsOf` is additional and ONLY for the cron stale-lease-recovery
 * sweep: the heartbeat/renewal path extends `processing_lease_expires_at` WITHOUT rotating the
 * token, so a token-only fence would let a sweep incorrectly steal a lease a live processor had
 * just legitimately renewed. Re-checked against the column's CURRENT value at mutation time, never
 * a value cached from an earlier SELECT.
 */
export interface LeaseFence {
  token: string;
  requireExpiredAsOf?: string;
}

function fenceClause(fence: LeaseFence): { sql: string; params: unknown[] } {
  if (fence.requireExpiredAsOf === undefined) {
    return { sql: 'processing_lease_token = ?', params: [fence.token] };
  }
  return {
    sql: 'processing_lease_token = ? AND processing_lease_expires_at <= ?',
    params: [fence.token, fence.requireExpiredAsOf],
  };
}

/** GPT-PM's exact DLQ predicate (validate3.py Scenarios A/C): PERMANENT_FAILURE always goes
 *  straight to DLQ regardless of attempt count; RETRYABLE_FAILURE only once the cap is reached. */
export function shouldMoveToDlq(
  outcome: 'RETRYABLE_FAILURE' | 'PERMANENT_FAILURE',
  attemptCountAtFailure: number,
  maxAttempts: number,
): boolean {
  return outcome === 'PERMANENT_FAILURE' || attemptCountAtFailure >= maxAttempts;
}

export interface FailureContext {
  eventId: string;
  fence: LeaseFence;
  now: string;
  errorClass: string;
  errorCode: string;
  processorVersion: string;
  traceId: string;
}

/**
 * Moves an event to DLQ. Shared, unchanged, by the live processor's own at-cap outcome and the
 * cron stale-lease-recovery sweep's at-cap outcome -- the only difference between the two callers
 * is the `fence` they pass in.
 *
 * Three statements in one D1 `batch()` transaction:
 * 1. The fenced state transition itself.
 * 2. Closes the outbox row -- self-conditioned on ingest_events' CURRENT (post-statement-1) state,
 *    never on statement 1's own rowcount, so it is correct regardless of whether THIS call or a
 *    concurrent racer actually performed the transition.
 * 3. The `dead_letter_events` insert -- same self-conditioning, plus a `NOT EXISTS` guard against
 *    its own PRIMARY KEY, so a replayed/concurrent recovery attempt against an already-DLQ'd event
 *    can never create a second record (dead_letter_events.event_id is the PRIMARY KEY; this guard
 *    is what makes a concurrent race resolve to exactly one row instead of a raw constraint error).
 * 4. Closes out the abandoned attempt's audit row, if one is still open.
 *
 * @returns true only if THIS call's own fenced UPDATE performed the transition (false if the fence
 * did not match -- a stale/lost race, not necessarily an error).
 */
export async function moveToDlq(db: D1Database, ctx: FailureContext): Promise<boolean> {
  const { sql: fenceSql, params: fenceParams } = fenceClause(ctx.fence);
  const results = await db.batch([
    db
      .prepare(
        `UPDATE ingest_events SET state='DLQ',
           first_failed_at = COALESCE(first_failed_at, ?),
           processing_lease_owner = NULL, processing_lease_token = NULL, processing_lease_expires_at = NULL
         WHERE event_id = ? AND state = 'PROCESSING' AND ${fenceSql}`,
      )
      .bind(ctx.now, ctx.eventId, ...fenceParams),
    db
      .prepare(
        `UPDATE processing_outbox SET state = 'CLOSED', updated_at = ?
         WHERE event_id = ? AND state <> 'CLOSED'
           AND EXISTS (SELECT 1 FROM ingest_events e WHERE e.event_id = ? AND e.state = 'DLQ')`,
      )
      .bind(ctx.now, ctx.eventId, ctx.eventId),
    db
      .prepare(
        `INSERT INTO dead_letter_events
           (event_id, error_class, error_code, processor_version, attempt_count, first_failed_at,
            last_failed_at, trace_id, created_at)
         SELECT ?, ?, ?, ?, e.processing_attempt_count, e.first_failed_at, ?, ?, ?
         FROM ingest_events e
         WHERE e.event_id = ? AND e.state = 'DLQ'
           AND NOT EXISTS (SELECT 1 FROM dead_letter_events d WHERE d.event_id = ?)`,
      )
      .bind(
        ctx.eventId,
        ctx.errorClass,
        ctx.errorCode,
        ctx.processorVersion,
        ctx.now,
        ctx.traceId,
        ctx.now,
        ctx.eventId,
        ctx.eventId,
      ),
    db
      .prepare(
        `UPDATE processing_attempts SET finished_at = ?, outcome = 'PERMANENT_FAILURE',
           error_class = ?, error_code = ?
         WHERE event_id = ?
           AND attempt_number = (SELECT processing_attempt_count FROM ingest_events WHERE event_id = ?)
           AND finished_at IS NULL`,
      )
      .bind(ctx.now, ctx.errorClass, ctx.errorCode, ctx.eventId, ctx.eventId),
  ]);
  const first = results[0];
  return first !== undefined && first.meta.changes === 1;
}

export interface RetryableFailureContext {
  eventId: string;
  fence: LeaseFence;
  now: string;
  nextAttemptAt: string;
  errorClass: string;
  errorCode: string;
}

/**
 * Moves an event back to RETRYABLE_FAILED (below the attempt cap) -- shared by the live processor
 * and the stale-lease-recovery sweep, same shape as `moveToDlq` but with no durable side-table
 * write, since a non-terminal outcome needs no operational record beyond the state itself.
 */
export async function moveToRetryableFailed(
  db: D1Database,
  ctx: RetryableFailureContext,
): Promise<boolean> {
  const { sql: fenceSql, params: fenceParams } = fenceClause(ctx.fence);
  const results = await db.batch([
    db
      .prepare(
        `UPDATE ingest_events SET state = 'RETRYABLE_FAILED',
           first_failed_at = COALESCE(first_failed_at, ?),
           processing_lease_owner = NULL, processing_lease_token = NULL, processing_lease_expires_at = NULL
         WHERE event_id = ? AND state = 'PROCESSING' AND ${fenceSql}`,
      )
      .bind(ctx.now, ctx.eventId, ...fenceParams),
    db
      .prepare(
        `UPDATE processing_outbox SET state = 'RETRY_PENDING', next_attempt_at = ?, updated_at = ?
         WHERE event_id = ?
           AND EXISTS (SELECT 1 FROM ingest_events e WHERE e.event_id = ? AND e.state = 'RETRYABLE_FAILED')`,
      )
      .bind(ctx.nextAttemptAt, ctx.now, ctx.eventId, ctx.eventId),
    db
      .prepare(
        `UPDATE processing_attempts SET finished_at = ?, outcome = 'RETRYABLE_FAILURE',
           error_class = ?, error_code = ?
         WHERE event_id = ?
           AND attempt_number = (SELECT processing_attempt_count FROM ingest_events WHERE event_id = ?)
           AND finished_at IS NULL`,
      )
      .bind(ctx.now, ctx.errorClass, ctx.errorCode, ctx.eventId, ctx.eventId),
  ]);
  const first = results[0];
  return first !== undefined && first.meta.changes === 1;
}
