import type { D1Database } from '@cloudflare/workers-types';

import { moveToDlq, moveToRetryableFailed, shouldMoveToDlq } from './transitions.js';

export interface ClaimOptions {
  eventId: string;
  workerId: string;
  leaseDurationMs: number;
  now: string;
  processorVersion: string;
  traceId: string;
}

export type ClaimResult =
  { claimed: true; token: string; attemptNumber: number } | { claimed: false };

/**
 * The live Queue consumer's own claim step: issues a FRESH lease token (never reused across
 * claims -- this is what lets the stale-lease-recovery sweep's ABA guard work at all) and advances
 * `processing_attempt_count`. Only ACCEPTED or RETRYABLE_FAILED rows are claimable -- a row already
 * PROCESSING under a live lease is not re-claimed by a duplicate/racing delivery of the same
 * dispatch.
 *
 * The `processing_attempts` audit row is written as a separate, non-batched call after the claim
 * succeeds: the attempt number it needs only exists once the claim's own RETURNING has resolved,
 * and losing this purely-observational row to an inter-call crash is an acceptable, deliberate
 * scope decision -- it never affects the state machine's own correctness.
 */
export async function claimLease(db: D1Database, opts: ClaimOptions): Promise<ClaimResult> {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.parse(opts.now) + opts.leaseDurationMs).toISOString();

  const claimed = await db
    .prepare(
      `UPDATE ingest_events SET state = 'PROCESSING',
         processing_attempt_count = processing_attempt_count + 1,
         processing_lease_owner = ?, processing_lease_token = ?, processing_lease_expires_at = ?
       WHERE event_id = ? AND state IN ('ACCEPTED', 'RETRYABLE_FAILED')
       RETURNING processing_attempt_count`,
    )
    .bind(opts.workerId, token, expiresAt, opts.eventId)
    .first<{ processing_attempt_count: number }>();

  if (!claimed) return { claimed: false };

  await db
    .prepare(
      `INSERT INTO processing_attempts
         (attempt_id, event_id, attempt_number, started_at, processor_version, trace_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      opts.eventId,
      claimed.processing_attempt_count,
      opts.now,
      opts.processorVersion,
      opts.traceId,
    )
    .run();

  return { claimed: true, token, attemptNumber: claimed.processing_attempt_count };
}

export interface HeartbeatOptions {
  eventId: string;
  token: string;
  now: string;
  leaseDurationMs: number;
}

/**
 * Renews a held lease's expiry WITHOUT rotating its token (migration 0001's own documented
 * behavior, and the exact property the stale-lease-recovery sweep's `requireExpiredAsOf` guard
 * exists to be safe against). Fenced on token alone: if a sweep already reclaimed this lease
 * (lost the race to the caller's own processing having stalled), this returns false and the
 * caller must abort rather than keep processing under a lease it no longer holds.
 */
export async function renewLease(db: D1Database, opts: HeartbeatOptions): Promise<boolean> {
  const expiresAt = new Date(Date.parse(opts.now) + opts.leaseDurationMs).toISOString();
  const result = await db
    .prepare(
      `UPDATE ingest_events SET processing_lease_expires_at = ?
       WHERE event_id = ? AND state = 'PROCESSING' AND processing_lease_token = ?`,
    )
    .bind(expiresAt, opts.eventId, opts.token)
    .run();
  return result.meta.changes === 1;
}

export interface CompleteOptions {
  eventId: string;
  token: string;
  now: string;
}

/** Terminal SUCCESS transition: PROCESSED, lease cleared, outbox closed, attempt row closed out. */
export async function completeProcessing(db: D1Database, opts: CompleteOptions): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE ingest_events SET state = 'PROCESSED',
           processing_lease_owner = NULL, processing_lease_token = NULL, processing_lease_expires_at = NULL
         WHERE event_id = ? AND state = 'PROCESSING' AND processing_lease_token = ?`,
      )
      .bind(opts.eventId, opts.token),
    db
      .prepare(
        `UPDATE processing_outbox SET state = 'CLOSED', updated_at = ?
         WHERE event_id = ? AND state <> 'CLOSED'
           AND EXISTS (SELECT 1 FROM ingest_events e WHERE e.event_id = ? AND e.state = 'PROCESSED')`,
      )
      .bind(opts.now, opts.eventId, opts.eventId),
    db
      .prepare(
        `UPDATE processing_attempts SET finished_at = ?, outcome = 'SUCCESS'
         WHERE event_id = ?
           AND attempt_number = (SELECT processing_attempt_count FROM ingest_events WHERE event_id = ?)
           AND finished_at IS NULL`,
      )
      .bind(opts.now, opts.eventId, opts.eventId),
  ]);
  const first = results[0];
  return first !== undefined && first.meta.changes === 1;
}

export interface FailOptions {
  eventId: string;
  token: string;
  now: string;
  outcome: 'RETRYABLE_FAILURE' | 'PERMANENT_FAILURE';
  attemptCountAtFailure: number;
  maxAttempts: number;
  nextAttemptAt: string;
  errorClass: string;
  errorCode: string;
  processorVersion: string;
  traceId: string;
}

export interface FailResult {
  transitioned: boolean;
  movedToDlq: boolean;
}

/** The live processor's own failure path -- token-only fenced (it holds a valid, non-expired
 *  lease by definition). Routes to `moveToDlq`/`moveToRetryableFailed`, the SAME primitives the
 *  stale-lease-recovery sweep uses for its own at-cap/below-cap outcomes. */
export async function failProcessing(db: D1Database, opts: FailOptions): Promise<FailResult> {
  const fence = { token: opts.token };
  if (shouldMoveToDlq(opts.outcome, opts.attemptCountAtFailure, opts.maxAttempts)) {
    const transitioned = await moveToDlq(db, {
      eventId: opts.eventId,
      fence,
      now: opts.now,
      errorClass: opts.errorClass,
      errorCode: opts.errorCode,
      processorVersion: opts.processorVersion,
      traceId: opts.traceId,
    });
    return { transitioned, movedToDlq: true };
  }
  const transitioned = await moveToRetryableFailed(db, {
    eventId: opts.eventId,
    fence,
    now: opts.now,
    nextAttemptAt: opts.nextAttemptAt,
    errorClass: opts.errorClass,
    errorCode: opts.errorCode,
  });
  return { transitioned, movedToDlq: false };
}
