import { describe, expect, it } from 'vitest';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { createTestD1, loadG2Schema, seedBaselineAccounts, seedEvent } from '@pdos/testkit';

import {
  moveToDlq,
  moveToRetryableFailed,
  shouldMoveToDlq,
  type LeaseFence,
  type RetryableFailureContext,
} from '../src/transitions.js';
import { claimLease } from '../src/lease.js';

const MAX_ATTEMPTS = 5;

describe('LeaseFence (type-level, type-design review G2)', () => {
  it('rejects both misuse directions the discriminated union exists to prevent', () => {
    // A LIVE fence must never carry requireExpiredAsOf -- that field only means something once
    // the SWEEP variant's own re-check semantics apply.
    // @ts-expect-error -- LIVE does not accept requireExpiredAsOf
    const liveWithExtra: LeaseFence = { kind: 'LIVE', token: 't', requireExpiredAsOf: 'x' };
    // A SWEEP fence must always carry requireExpiredAsOf -- omitting it silently degrades to a
    // token-only fence, which is exactly the ABA hole this type exists to make unrepresentable.
    // @ts-expect-error -- SWEEP requires requireExpiredAsOf
    const sweepMissing: LeaseFence = { kind: 'SWEEP', token: 't' };
    expect(liveWithExtra.kind).toBe('LIVE');
    expect(sweepMissing.kind).toBe('SWEEP');
  });
});

describe('shouldMoveToDlq', () => {
  it('is true for PERMANENT_FAILURE regardless of attempt count', () => {
    expect(shouldMoveToDlq('PERMANENT_FAILURE', 1, MAX_ATTEMPTS)).toBe(true);
  });
  it('is false for RETRYABLE_FAILURE below the cap', () => {
    expect(shouldMoveToDlq('RETRYABLE_FAILURE', 2, MAX_ATTEMPTS)).toBe(false);
  });
  it('is true for RETRYABLE_FAILURE at the cap', () => {
    expect(shouldMoveToDlq('RETRYABLE_FAILURE', MAX_ATTEMPTS, MAX_ATTEMPTS)).toBe(true);
  });
});

async function setupProcessingEvent(eventId: string, attemptCount: number, token = 'token-A') {
  const db = createTestD1(loadG2Schema());
  const accounts = await seedBaselineAccounts(db);
  await seedEvent(db, accounts, {
    eventId,
    state: 'PROCESSING',
    attemptCount,
    leaseOwner: 'worker-1',
    leaseToken: token,
    leaseExpiresAt: '2026-09-13T00:02:00.000Z',
  });
  await db
    .prepare(
      'INSERT INTO processing_outbox (event_id, state, dispatch_count, next_attempt_at, dispatched_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      eventId,
      'DISPATCHED',
      1,
      '2026-09-13T00:00:00.000Z',
      '2026-09-13T00:00:00.000Z',
      '2026-09-13T00:00:00.000Z',
    )
    .run();
  await db
    .prepare(
      'INSERT INTO processing_attempts (attempt_id, event_id, attempt_number, started_at, processor_version, trace_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind('attempt-1', eventId, attemptCount, '2026-09-13T00:00:00.000Z', 'proc-v1', 'trace-1')
    .run();
  return db;
}

describe('moveToDlq', () => {
  it('transitions the event to DLQ, closes the outbox, writes exactly one dead_letter_events row', async () => {
    const db = await setupProcessingEvent('ev-1', 5);
    const ok = await moveToDlq(db, {
      eventId: 'ev-1',
      fence: { kind: 'LIVE', token: 'token-A' },
      now: '2026-09-13T00:03:00.000Z',
      errorClass: 'TimeoutError',
      errorCode: 'E_TIMEOUT',
      processorVersion: 'proc-v1',
      traceId: 'trace-1',
      terminalOutcome: 'PERMANENT_FAILURE',
    });
    expect(ok).toBe(true);

    const event = await db
      .prepare('SELECT state, processing_lease_token FROM ingest_events WHERE event_id = ?')
      .bind('ev-1')
      .first<{ state: string; processing_lease_token: string | null }>();
    expect(event).toEqual({ state: 'DLQ', processing_lease_token: null });

    const outbox = await db
      .prepare('SELECT state FROM processing_outbox WHERE event_id = ?')
      .bind('ev-1')
      .first<{ state: string }>();
    expect(outbox?.state).toBe('CLOSED');

    const dlqRows = await db
      .prepare('SELECT COUNT(*) as n FROM dead_letter_events WHERE event_id = ?')
      .bind('ev-1')
      .first<{ n: number }>();
    expect(dlqRows?.n).toBe(1);

    const attempt = await db
      .prepare('SELECT outcome, finished_at FROM processing_attempts WHERE event_id = ?')
      .bind('ev-1')
      .first<{ outcome: string; finished_at: string }>();
    expect(attempt?.outcome).toBe('PERMANENT_FAILURE');
    expect(attempt?.finished_at).not.toBeNull();
  });

  it('returns false and makes no change when the fenced token does not match (lost race)', async () => {
    const db = await setupProcessingEvent('ev-2', 5, 'token-REAL');
    const ok = await moveToDlq(db, {
      eventId: 'ev-2',
      fence: { kind: 'LIVE', token: 'token-STALE' },
      now: '2026-09-13T00:03:00.000Z',
      errorClass: 'TimeoutError',
      errorCode: 'E_TIMEOUT',
      processorVersion: 'proc-v1',
      traceId: 'trace-1',
      terminalOutcome: 'PERMANENT_FAILURE',
    });
    expect(ok).toBe(false);

    const event = await db
      .prepare('SELECT state FROM ingest_events WHERE event_id = ?')
      .bind('ev-2')
      .first<{ state: string }>();
    expect(event?.state).toBe('PROCESSING');
  });

  it('produces exactly one dead_letter_events row under a concurrent replay racing the same event', async () => {
    const db = await setupProcessingEvent('ev-3', 5);
    const call = () =>
      moveToDlq(db, {
        eventId: 'ev-3',
        fence: { kind: 'LIVE', token: 'token-A' },
        now: '2026-09-13T00:03:00.000Z',
        errorClass: 'TimeoutError',
        errorCode: 'E_TIMEOUT',
        processorVersion: 'proc-v1',
        traceId: 'trace-1',
        terminalOutcome: 'PERMANENT_FAILURE',
      });

    // Two "concurrent" attempts against the SAME fence -- the test D1 shim serializes writers just
    // like real D1 does, so this proves the self-conditioning NOT EXISTS guard, not a race outcome
    // that depends on timing.
    const [first, second] = await Promise.all([call(), call()]);
    expect([first, second].filter(Boolean)).toHaveLength(1);

    const dlqRows = await db
      .prepare('SELECT COUNT(*) as n FROM dead_letter_events WHERE event_id = ?')
      .bind('ev-3')
      .first<{ n: number }>();
    expect(dlqRows?.n).toBe(1);
  });

  it('requireExpiredAsOf fences against a lease renewed after the token was observed', async () => {
    const db = await setupProcessingEvent('ev-4', 5, 'token-A');
    // Simulate the live processor's own heartbeat extending the lease PAST "now" -- same token,
    // later expiry -- between when the sweep observed the row and when it mutates.
    await db
      .prepare('UPDATE ingest_events SET processing_lease_expires_at = ? WHERE event_id = ?')
      .bind('2026-09-13T00:10:00.000Z', 'ev-4')
      .run();

    const ok = await moveToDlq(db, {
      eventId: 'ev-4',
      fence: {
        kind: 'SWEEP',
        token: 'token-A',
        requireExpiredAsOf: '2026-09-13T00:03:00.000Z',
      },
      now: '2026-09-13T00:03:00.000Z',
      errorClass: 'LEASE_EXPIRED',
      errorCode: 'STALE_LEASE_RECOVERY_AT_CAP',
      processorVersion: 'sweep',
      traceId: 'trace-1',
      terminalOutcome: 'RETRYABLE_FAILURE',
    });
    expect(ok).toBe(false);

    const event = await db
      .prepare('SELECT state FROM ingest_events WHERE event_id = ?')
      .bind('ev-4')
      .first<{ state: string }>();
    expect(event?.state).toBe('PROCESSING');
  });

  it('MAJOR regression (G2 gate review): records the ACTUAL terminal cause in the attempt audit row, not a hardcoded PERMANENT_FAILURE', async () => {
    const db = await setupProcessingEvent('ev-audit', 5);
    const ok = await moveToDlq(db, {
      eventId: 'ev-audit',
      fence: { kind: 'LIVE', token: 'token-A' },
      now: '2026-09-13T00:03:00.000Z',
      errorClass: 'LEASE_EXPIRED',
      errorCode: 'STALE_LEASE_RECOVERY_AT_CAP',
      processorVersion: 'sweep',
      traceId: 'trace-1',
      terminalOutcome: 'RETRYABLE_FAILURE',
    });
    expect(ok).toBe(true);

    const attempt = await db
      .prepare('SELECT outcome FROM processing_attempts WHERE event_id = ?')
      .bind('ev-audit')
      .first<{ outcome: string }>();
    expect(attempt?.outcome).toBe('RETRYABLE_FAILURE');
  });
});

describe('moveToRetryableFailed', () => {
  it('transitions to RETRYABLE_FAILED, reopens the outbox to RETRY_PENDING, clears the lease', async () => {
    const db = await setupProcessingEvent('ev-5', 2);
    const ok = await moveToRetryableFailed(db, {
      eventId: 'ev-5',
      fence: { kind: 'LIVE', token: 'token-A' },
      now: '2026-09-13T00:03:00.000Z',
      nextAttemptAt: '2026-09-13T00:05:00.000Z',
      errorClass: 'NetworkError',
      errorCode: 'E_NET',
    });
    expect(ok).toBe(true);

    const event = await db
      .prepare(
        'SELECT state, processing_lease_token, processing_lease_expires_at FROM ingest_events WHERE event_id = ?',
      )
      .bind('ev-5')
      .first<{
        state: string;
        processing_lease_token: string | null;
        processing_lease_expires_at: string | null;
      }>();
    expect(event).toEqual({
      state: 'RETRYABLE_FAILED',
      processing_lease_token: null,
      processing_lease_expires_at: null,
    });

    const outbox = await db
      .prepare('SELECT state, next_attempt_at FROM processing_outbox WHERE event_id = ?')
      .bind('ev-5')
      .first<{ state: string; next_attempt_at: string }>();
    expect(outbox).toEqual({ state: 'RETRY_PENDING', next_attempt_at: '2026-09-13T00:05:00.000Z' });

    const dlqRows = await db
      .prepare('SELECT COUNT(*) as n FROM dead_letter_events')
      .first<{ n: number }>();
    expect(dlqRows?.n).toBe(0);
  });

  it("MAJOR regression (G2 gate review): a loser cannot clobber the winner's chosen backoff -- a stale sweep call after a live-processor win touches nothing", async () => {
    const db = await setupProcessingEvent('ev-race-backoff', 2, 'token-A');

    const liveWon = await moveToRetryableFailed(db, {
      eventId: 'ev-race-backoff',
      fence: { kind: 'LIVE', token: 'token-A' },
      now: '2026-09-13T00:03:00.000Z',
      nextAttemptAt: '2026-09-13T00:08:00.000Z', // the live processor's real per-attempt backoff
      errorClass: 'NetworkError',
      errorCode: 'E_NET',
    });
    expect(liveWon).toBe(true);

    // A stale sweep call for the SAME event arrives after the live processor already won --
    // ingest_events is no longer PROCESSING, so its own fenced transition cannot match regardless
    // of the token/expiry it presents.
    const sweepLost = await moveToRetryableFailed(db, {
      eventId: 'ev-race-backoff',
      fence: { kind: 'SWEEP', token: 'token-A', requireExpiredAsOf: '2026-09-13T00:03:00.000Z' },
      now: '2026-09-13T00:03:01.000Z',
      nextAttemptAt: '2026-09-13T00:03:01.000Z', // the sweep's own "retry immediately"
      errorClass: 'LEASE_EXPIRED',
      errorCode: 'STALE_LEASE_RECOVERY',
    });
    expect(sweepLost).toBe(false);

    // The winner's backoff must survive untouched -- before this fix, the loser's own outbox
    // UPDATE matched merely on "state is RETRYABLE_FAILED" and would have overwritten it.
    const outbox = await db
      .prepare('SELECT next_attempt_at FROM processing_outbox WHERE event_id = ?')
      .bind('ev-race-backoff')
      .first<{ next_attempt_at: string }>();
    expect(outbox?.next_attempt_at).toBe('2026-09-13T00:08:00.000Z');
  });

  it('BLOCKER regression (GPT-PM, G2 gate review round 2): a duplicate claim immediately after moveToRetryableFailed resolves is rejected because the outbox is already RETRY_PENDING', async () => {
    const db = await setupProcessingEvent('ev-atomic-retry', 1, 'token-A');
    const ok = await moveToRetryableFailed(db, {
      eventId: 'ev-atomic-retry',
      fence: { kind: 'LIVE', token: 'token-A' },
      now: '2026-09-13T00:03:00.000Z',
      nextAttemptAt: '2026-09-13T00:08:00.000Z',
      errorClass: 'NetworkError',
      errorCode: 'E_NET',
    });
    expect(ok).toBe(true);

    const duplicateClaim = await claimLease(db, {
      eventId: 'ev-atomic-retry',
      workerId: 'worker-2',
      leaseDurationMs: 60_000,
      now: '2026-09-13T00:03:01.000Z',
      processorVersion: 'proc-v1',
      traceId: 'trace-1',
      maxAttempts: 5,
    });
    expect(duplicateClaim.claimed).toBe(false);

    const outbox = await db
      .prepare('SELECT state FROM processing_outbox WHERE event_id = ?')
      .bind('ev-atomic-retry')
      .first<{ state: string }>();
    expect(outbox?.state).toBe('RETRY_PENDING');
  });

  /**
   * GPT-PM MAJOR, round 3: the post-hoc test above proves the OUTCOME but not the FIX -- it awaits
   * `moveToRetryableFailed` to full completion before ever calling `claimLease`, so the checkpoint-4
   * BROKEN two-step implementation (standalone `ingest_events` `.run()`, THEN a separate
   * `db.batch()`) would ALSO have already finished both steps by the time the duplicate claim runs,
   * passing this same assertion for the wrong reason. The genuinely vulnerable window only existed
   * BETWEEN those two steps, never observable after the function returns either way.
   *
   * This probe distinguishes the two implementations directly: it wraps the db so that calling
   * `.run()` STANDALONE (not via `db.batch()`) on the `ingest_events -> RETRYABLE_FAILED` statement
   * triggers an injected duplicate-claim attempt immediately afterward, in what would be exactly the
   * broken implementation's own vulnerable gap. The CURRENT implementation issues this statement
   * only inside one `db.batch()` call (never as a standalone `.run()`), so this hook never fires at
   * all against it. `oldBrokenMoveToRetryableFailed` below is a literal copy of checkpoint-4's own
   * pre-round-2 code, run through the SAME probe, to prove the probe is not vacuous: it actually
   * catches the exact regression it is named for.
   */
  function wrapDbForRetryRaceProbe(
    db: D1Database,
    onStandaloneTransitionRun: () => Promise<void>,
  ): D1Database {
    const TRANSITION_MARKER = "SET state = 'RETRYABLE_FAILED'";
    return {
      prepare(sql: string): D1PreparedStatement {
        const real = db.prepare(sql);
        if (!sql.includes(TRANSITION_MARKER)) return real;
        return {
          bind(...args: unknown[]): D1PreparedStatement {
            const boundReal = real.bind(...args);
            const boundRealBatchable = boundReal as unknown as {
              runRawForBatch: () => D1Result<unknown>;
            };
            return {
              async run<T>(): Promise<D1Result<T>> {
                // Only a STANDALONE call reaches this method at all -- a statement handed to
                // `db.batch()` is executed via the shim's own internal `runRawForBatch`, never
                // this public `run()` (packages/testkit/src/d1.ts).
                const result = await boundReal.run<T>();
                await onStandaloneTransitionRun();
                return result;
              },
              runRawForBatch<T>(): D1Result<T> {
                return boundRealBatchable.runRawForBatch() as D1Result<T>;
              },
              first: boundReal.first.bind(boundReal),
              all: boundReal.all.bind(boundReal),
              raw: boundReal.raw.bind(boundReal),
            } as unknown as D1PreparedStatement;
          },
        } as unknown as D1PreparedStatement;
      },
      batch: db.batch.bind(db),
      exec: db.exec.bind(db),
      withSession: db.withSession.bind(db),
      dump: db.dump.bind(db),
    } as D1Database;
  }

  /** Literal copy of checkpoint-4's own pre-round-2 `moveToRetryableFailed` -- the exact code the
   *  round-2 BLOCKER was filed against. LIVE-fence only, matching every test call site above. */
  async function oldBrokenMoveToRetryableFailed(
    db: D1Database,
    ctx: RetryableFailureContext & { fence: { kind: 'LIVE'; token: string } },
  ): Promise<boolean> {
    const transition = await db
      .prepare(
        `UPDATE ingest_events SET state = 'RETRYABLE_FAILED',
           first_failed_at = COALESCE(first_failed_at, ?),
           processing_lease_owner = NULL, processing_lease_token = NULL, processing_lease_expires_at = NULL
         WHERE event_id = ? AND state = 'PROCESSING' AND processing_lease_token = ?`,
      )
      .bind(ctx.now, ctx.eventId, ctx.fence.token)
      .run();
    if (transition.meta.changes !== 1) return false;

    await db.batch([
      db
        .prepare(
          `UPDATE processing_outbox SET state = 'RETRY_PENDING', next_attempt_at = ?, updated_at = ?
           WHERE event_id = ? AND state <> 'CLOSED'`,
        )
        .bind(ctx.nextAttemptAt, ctx.now, ctx.eventId),
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
    return true;
  }

  it('BLOCKER regression, hardened (GPT-PM round 3): the current implementation never exposes the standalone-run hook, so the probe observes no vulnerable window', async () => {
    const db = await setupProcessingEvent('ev-probe-current', 1, 'token-A');
    let standaloneRunObserved = false;
    let duringWindowClaim: { claimed: boolean } | undefined;
    const probedDb = wrapDbForRetryRaceProbe(db, async () => {
      standaloneRunObserved = true;
      duringWindowClaim = await claimLease(db, {
        eventId: 'ev-probe-current',
        workerId: 'worker-2',
        leaseDurationMs: 60_000,
        now: '2026-09-13T00:03:00.500Z',
        processorVersion: 'proc-v1',
        traceId: 'trace-1',
        maxAttempts: 5,
      });
    });

    const ok = await moveToRetryableFailed(probedDb, {
      eventId: 'ev-probe-current',
      fence: { kind: 'LIVE', token: 'token-A' },
      now: '2026-09-13T00:03:00.000Z',
      nextAttemptAt: '2026-09-13T00:08:00.000Z',
      errorClass: 'NetworkError',
      errorCode: 'E_NET',
    });
    expect(ok).toBe(true);
    expect(standaloneRunObserved).toBe(false);
    expect(duringWindowClaim).toBeUndefined();
  });

  it('BLOCKER regression, hardened (GPT-PM round 3): the SAME probe against the pre-round-2 broken implementation DOES catch the vulnerable window (proves the probe is not vacuous)', async () => {
    const db = await setupProcessingEvent('ev-probe-old', 1, 'token-A');
    let standaloneRunObserved = false;
    let duringWindowClaim: { claimed: boolean } | undefined;
    const probedDb = wrapDbForRetryRaceProbe(db, async () => {
      standaloneRunObserved = true;
      duringWindowClaim = await claimLease(db, {
        eventId: 'ev-probe-old',
        workerId: 'worker-2',
        leaseDurationMs: 60_000,
        now: '2026-09-13T00:03:00.500Z',
        processorVersion: 'proc-v1',
        traceId: 'trace-1',
        maxAttempts: 5,
      });
    });

    const ok = await oldBrokenMoveToRetryableFailed(probedDb, {
      eventId: 'ev-probe-old',
      fence: { kind: 'LIVE', token: 'token-A' },
      now: '2026-09-13T00:03:00.000Z',
      nextAttemptAt: '2026-09-13T00:08:00.000Z',
      errorClass: 'NetworkError',
      errorCode: 'E_NET',
    });
    expect(ok).toBe(true);
    expect(standaloneRunObserved).toBe(true);
    // The exact bug: a duplicate claim landing in the gap between the two steps succeeds.
    expect(duringWindowClaim?.claimed).toBe(true);
  });

  it('BLOCKER regression, crash-between-steps proof (GPT-PM round 3): a mid-batch D1 failure rolls back the whole transaction -- no partial commit', async () => {
    const db = await setupProcessingEvent('ev-crash-mid-batch', 2, 'token-A');
    // Throws only when the audit-row statement (uniquely identified by its literal
    // `outcome = 'RETRYABLE_FAILURE'`) is executed as part of a `db.batch()` -- simulating a D1
    // failure partway through the transaction this function's own atomicity depends on.
    const throwingDb: D1Database = {
      prepare(sql: string): D1PreparedStatement {
        const real = db.prepare(sql);
        if (!sql.includes("outcome = 'RETRYABLE_FAILURE'")) return real;
        return {
          bind(): D1PreparedStatement {
            return {
              runRawForBatch(): never {
                throw new Error('simulated mid-batch D1 failure');
              },
            } as unknown as D1PreparedStatement;
          },
        } as unknown as D1PreparedStatement;
      },
      batch: db.batch.bind(db),
      exec: db.exec.bind(db),
      withSession: db.withSession.bind(db),
      dump: db.dump.bind(db),
    } as D1Database;

    await expect(
      moveToRetryableFailed(throwingDb, {
        eventId: 'ev-crash-mid-batch',
        fence: { kind: 'LIVE', token: 'token-A' },
        now: '2026-09-13T00:03:00.000Z',
        nextAttemptAt: '2026-09-13T00:08:00.000Z',
        errorClass: 'NetworkError',
        errorCode: 'E_NET',
      }),
    ).rejects.toThrow();

    const event = await db
      .prepare('SELECT state, processing_lease_token FROM ingest_events WHERE event_id = ?')
      .bind('ev-crash-mid-batch')
      .first<{ state: string; processing_lease_token: string | null }>();
    expect(event).toEqual({ state: 'PROCESSING', processing_lease_token: 'token-A' });

    const outbox = await db
      .prepare('SELECT state FROM processing_outbox WHERE event_id = ?')
      .bind('ev-crash-mid-batch')
      .first<{ state: string }>();
    expect(outbox?.state).toBe('DISPATCHED');

    const attempt = await db
      .prepare('SELECT finished_at FROM processing_attempts WHERE event_id = ?')
      .bind('ev-crash-mid-batch')
      .first<{ finished_at: string | null }>();
    expect(attempt?.finished_at).toBeNull();
  });
});
