import type { D1Database } from '@cloudflare/workers-types';

import {
  moveToDlq,
  moveToRetryableFailed,
  shouldMoveToDlq,
  type LeaseFence,
} from './transitions.js';

export interface RecoverStaleLeasesOptions {
  now: string;
  maxAttempts: number;
  batchSize: number;
  processorVersion: string;
}

export interface RecoveredLease {
  eventId: string;
  outcome: 'DLQ' | 'RETRYABLE_FAILED' | 'RACE_LOST';
}

/**
 * Phase 1 of the ingest scheduled handler (TDD): reclaims PROCESSING rows whose lease has expired.
 * An abandoned lease is always treated as a RETRYABLE_FAILURE from the sweep's own point of view --
 * a sweep can never know a processor's own PERMANENT_FAILURE verdict, only that nothing reported
 * back before the lease ran out -- so it only ever escalates to DLQ once the attempt cap is
 * genuinely reached, via the exact same `shouldMoveToDlq`/`moveToDlq`/`moveToRetryableFailed`
 * primitives the live processor's own failure path uses.
 *
 * Every mutation fences on BOTH the observed token AND a fresh `processing_lease_expires_at <= now`
 * re-check (`requireExpiredAsOf`) -- the ABA/heartbeat-race guard documented on `LeaseFence`. A
 * `RACE_LOST` outcome is expected, not an error: it means the live processor (or a concurrent sweep
 * run) already resolved this event between the SELECT above and this row's own mutation.
 */
export async function recoverStaleLeases(
  db: D1Database,
  opts: RecoverStaleLeasesOptions,
): Promise<RecoveredLease[]> {
  const candidates = await db
    .prepare(
      `SELECT event_id, processing_attempt_count, processing_lease_token, trace_id
       FROM ingest_events
       WHERE state = 'PROCESSING' AND processing_lease_expires_at <= ?
       ORDER BY processing_lease_expires_at
       LIMIT ?`,
    )
    .bind(opts.now, opts.batchSize)
    .all<{
      event_id: string;
      processing_attempt_count: number;
      processing_lease_token: string;
      trace_id: string;
    }>();

  const recovered: RecoveredLease[] = [];
  for (const row of candidates.results) {
    const fence: LeaseFence = {
      kind: 'SWEEP',
      token: row.processing_lease_token,
      requireExpiredAsOf: opts.now,
    };

    if (shouldMoveToDlq('RETRYABLE_FAILURE', row.processing_attempt_count, opts.maxAttempts)) {
      const transitioned = await moveToDlq(db, {
        eventId: row.event_id,
        fence,
        now: opts.now,
        errorClass: 'LEASE_EXPIRED',
        errorCode: 'STALE_LEASE_RECOVERY_AT_CAP',
        processorVersion: opts.processorVersion,
        traceId: row.trace_id,
      });
      recovered.push({ eventId: row.event_id, outcome: transitioned ? 'DLQ' : 'RACE_LOST' });
      continue;
    }

    const transitioned = await moveToRetryableFailed(db, {
      eventId: row.event_id,
      fence,
      now: opts.now,
      nextAttemptAt: opts.now,
      errorClass: 'LEASE_EXPIRED',
      errorCode: 'STALE_LEASE_RECOVERY',
    });
    recovered.push({
      eventId: row.event_id,
      outcome: transitioned ? 'RETRYABLE_FAILED' : 'RACE_LOST',
    });
  }
  return recovered;
}
