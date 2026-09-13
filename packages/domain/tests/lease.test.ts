import { describe, expect, it } from 'vitest';
import {
  createTestD1,
  loadG2Schema,
  seedBaselineAccounts,
  seedEvent,
  seedOutbox,
} from '@pdos/testkit';

import { claimLease, completeProcessing, failProcessing, renewLease } from '../src/lease.js';

async function setupAcceptedEvent(eventId: string) {
  const db = createTestD1(loadG2Schema());
  const accounts = await seedBaselineAccounts(db);
  await seedEvent(db, accounts, { eventId, state: 'ACCEPTED' });
  await seedOutbox(db, eventId, { state: 'DISPATCHED', dispatchedAt: '2026-09-13T00:00:00.000Z' });
  return db;
}

describe('claimLease', () => {
  it('claims an ACCEPTED event, issuing a fresh token and advancing the attempt count', async () => {
    const db = await setupAcceptedEvent('ev-1');
    const result = await claimLease(db, {
      eventId: 'ev-1',
      workerId: 'worker-1',
      leaseDurationMs: 120_000,
      now: '2026-09-13T00:00:00.000Z',
      processorVersion: 'proc-v1',
      traceId: 'trace-1',
    });
    expect(result.claimed).toBe(true);
    if (!result.claimed) throw new Error('unreachable');
    expect(result.attemptNumber).toBe(1);
    expect(result.token).toMatch(/^[0-9a-f-]{36}$/);

    const row = await db
      .prepare(
        'SELECT state, processing_lease_token, processing_lease_expires_at FROM ingest_events WHERE event_id = ?',
      )
      .bind('ev-1')
      .first<{
        state: string;
        processing_lease_token: string;
        processing_lease_expires_at: string;
      }>();
    expect(row?.state).toBe('PROCESSING');
    expect(row?.processing_lease_token).toBe(result.token);
    expect(row?.processing_lease_expires_at).toBe('2026-09-13T00:02:00.000Z');

    const attempt = await db
      .prepare('SELECT attempt_number, started_at FROM processing_attempts WHERE event_id = ?')
      .bind('ev-1')
      .first<{ attempt_number: number; started_at: string }>();
    expect(attempt).toEqual({ attempt_number: 1, started_at: '2026-09-13T00:00:00.000Z' });
  });

  it('does not claim a row already PROCESSING under a live lease', async () => {
    const db = await setupAcceptedEvent('ev-2');
    const first = await claimLease(db, {
      eventId: 'ev-2',
      workerId: 'worker-1',
      leaseDurationMs: 120_000,
      now: '2026-09-13T00:00:00.000Z',
      processorVersion: 'proc-v1',
      traceId: 'trace-1',
    });
    expect(first.claimed).toBe(true);

    const second = await claimLease(db, {
      eventId: 'ev-2',
      workerId: 'worker-2',
      leaseDurationMs: 120_000,
      now: '2026-09-13T00:00:05.000Z',
      processorVersion: 'proc-v1',
      traceId: 'trace-1',
    });
    expect(second.claimed).toBe(false);
  });

  it('reclaims a RETRYABLE_FAILED row, advancing to attempt 2', async () => {
    const db = createTestD1(loadG2Schema());
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, {
      eventId: 'ev-3',
      state: 'RETRYABLE_FAILED',
      attemptCount: 1,
      firstFailedAt: '2026-09-13T00:00:00.000Z',
    });
    const result = await claimLease(db, {
      eventId: 'ev-3',
      workerId: 'worker-1',
      leaseDurationMs: 60_000,
      now: '2026-09-13T00:05:00.000Z',
      processorVersion: 'proc-v1',
      traceId: 'trace-1',
    });
    expect(result.claimed).toBe(true);
    if (!result.claimed) throw new Error('unreachable');
    expect(result.attemptNumber).toBe(2);
  });
});

describe('renewLease', () => {
  it('extends expiry without rotating the token', async () => {
    const db = await setupAcceptedEvent('ev-4');
    const claim = await claimLease(db, {
      eventId: 'ev-4',
      workerId: 'worker-1',
      leaseDurationMs: 60_000,
      now: '2026-09-13T00:00:00.000Z',
      processorVersion: 'proc-v1',
      traceId: 'trace-1',
    });
    if (!claim.claimed) throw new Error('unreachable');

    const renewed = await renewLease(db, {
      eventId: 'ev-4',
      token: claim.token,
      now: '2026-09-13T00:00:50.000Z',
      leaseDurationMs: 60_000,
    });
    expect(renewed).toBe(true);

    const row = await db
      .prepare(
        'SELECT processing_lease_token, processing_lease_expires_at FROM ingest_events WHERE event_id = ?',
      )
      .bind('ev-4')
      .first<{ processing_lease_token: string; processing_lease_expires_at: string }>();
    expect(row?.processing_lease_token).toBe(claim.token);
    expect(row?.processing_lease_expires_at).toBe('2026-09-13T00:01:50.000Z');
  });

  it('is fenced: fails once the lease has been reclaimed under a different token', async () => {
    const db = await setupAcceptedEvent('ev-5');
    const claim = await claimLease(db, {
      eventId: 'ev-5',
      workerId: 'worker-1',
      leaseDurationMs: 60_000,
      now: '2026-09-13T00:00:00.000Z',
      processorVersion: 'proc-v1',
      traceId: 'trace-1',
    });
    if (!claim.claimed) throw new Error('unreachable');

    // Simulate a sweep having reclaimed the lease already (token cleared, event failed out).
    await db
      .prepare(
        "UPDATE ingest_events SET state = 'RETRYABLE_FAILED', processing_lease_token = NULL, processing_lease_owner = NULL, processing_lease_expires_at = NULL WHERE event_id = ?",
      )
      .bind('ev-5')
      .run();

    const renewed = await renewLease(db, {
      eventId: 'ev-5',
      token: claim.token,
      now: '2026-09-13T00:00:50.000Z',
      leaseDurationMs: 60_000,
    });
    expect(renewed).toBe(false);
  });
});

describe('completeProcessing', () => {
  it('marks PROCESSED, closes the outbox, and closes out the attempt row', async () => {
    const db = await setupAcceptedEvent('ev-6');
    const claim = await claimLease(db, {
      eventId: 'ev-6',
      workerId: 'worker-1',
      leaseDurationMs: 60_000,
      now: '2026-09-13T00:00:00.000Z',
      processorVersion: 'proc-v1',
      traceId: 'trace-1',
    });
    if (!claim.claimed) throw new Error('unreachable');

    const ok = await completeProcessing(db, {
      eventId: 'ev-6',
      token: claim.token,
      now: '2026-09-13T00:00:10.000Z',
    });
    expect(ok).toBe(true);

    const event = await db
      .prepare('SELECT state FROM ingest_events WHERE event_id = ?')
      .bind('ev-6')
      .first<{ state: string }>();
    expect(event?.state).toBe('PROCESSED');

    const outbox = await db
      .prepare('SELECT state FROM processing_outbox WHERE event_id = ?')
      .bind('ev-6')
      .first<{ state: string }>();
    expect(outbox?.state).toBe('CLOSED');

    const attempt = await db
      .prepare('SELECT outcome FROM processing_attempts WHERE event_id = ?')
      .bind('ev-6')
      .first<{ outcome: string }>();
    expect(attempt?.outcome).toBe('SUCCESS');
  });
});

describe('failProcessing', () => {
  it('below cap + RETRYABLE_FAILURE -> RETRYABLE_FAILED, not DLQ', async () => {
    const db = await setupAcceptedEvent('ev-7');
    const claim = await claimLease(db, {
      eventId: 'ev-7',
      workerId: 'worker-1',
      leaseDurationMs: 60_000,
      now: '2026-09-13T00:00:00.000Z',
      processorVersion: 'proc-v1',
      traceId: 'trace-1',
    });
    if (!claim.claimed) throw new Error('unreachable');

    const result = await failProcessing(db, {
      eventId: 'ev-7',
      token: claim.token,
      now: '2026-09-13T00:00:10.000Z',
      outcome: 'RETRYABLE_FAILURE',
      attemptCountAtFailure: claim.attemptNumber,
      maxAttempts: 5,
      nextAttemptAt: '2026-09-13T00:05:00.000Z',
      errorClass: 'NetworkError',
      errorCode: 'E_NET',
      processorVersion: 'proc-v1',
      traceId: 'trace-1',
    });
    expect(result).toEqual({ transitioned: true, movedToDlq: false });

    const event = await db
      .prepare('SELECT state FROM ingest_events WHERE event_id = ?')
      .bind('ev-7')
      .first<{ state: string }>();
    expect(event?.state).toBe('RETRYABLE_FAILED');
  });

  it('PERMANENT_FAILURE at attempt 1 (below cap) goes straight to DLQ', async () => {
    const db = await setupAcceptedEvent('ev-8');
    const claim = await claimLease(db, {
      eventId: 'ev-8',
      workerId: 'worker-1',
      leaseDurationMs: 60_000,
      now: '2026-09-13T00:00:00.000Z',
      processorVersion: 'proc-v1',
      traceId: 'trace-1',
    });
    if (!claim.claimed) throw new Error('unreachable');

    const result = await failProcessing(db, {
      eventId: 'ev-8',
      token: claim.token,
      now: '2026-09-13T00:00:10.000Z',
      outcome: 'PERMANENT_FAILURE',
      attemptCountAtFailure: claim.attemptNumber,
      maxAttempts: 5,
      nextAttemptAt: '2026-09-13T00:05:00.000Z',
      errorClass: 'ValidationError',
      errorCode: 'E_INVALID',
      processorVersion: 'proc-v1',
      traceId: 'trace-1',
    });
    expect(result).toEqual({ transitioned: true, movedToDlq: true });

    const event = await db
      .prepare('SELECT state FROM ingest_events WHERE event_id = ?')
      .bind('ev-8')
      .first<{ state: string }>();
    expect(event?.state).toBe('DLQ');
  });

  it('full ABA sequence: claim -> expire -> reclaim with a fresh token -> stale mutation rejected -> fresh mutation succeeds', async () => {
    const db = await setupAcceptedEvent('ev-aba');
    const claimA = await claimLease(db, {
      eventId: 'ev-aba',
      workerId: 'worker-X',
      leaseDurationMs: 60_000,
      now: '2026-09-12T23:00:00.000Z',
      processorVersion: 'proc-v1',
      traceId: 'trace-1',
    });
    if (!claimA.claimed) throw new Error('unreachable');

    // The lease has now expired (2026-09-12T23:01:00Z) relative to "now" below. A stale-lease
    // sweep reclaims it with a FRESH token, fenced on the observed token AND the expiry re-check.
    const { recoverStaleLeases } = await import('../src/lease-recovery.js');
    const recovered = await recoverStaleLeases(db, {
      now: '2026-09-13T00:10:00.000Z',
      maxAttempts: 5,
      batchSize: 10,
      processorVersion: 'stale-lease-recovery-sweep',
    });
    expect(recovered).toEqual([{ eventId: 'ev-aba', outcome: 'RETRYABLE_FAILED' }]);

    // The ORIGINAL holder's stale mutation, still carrying token A, must be rejected -- the ABA
    // guard. It is no longer even in PROCESSING (the sweep already moved it), so this must fail.
    const staleComplete = await completeProcessing(db, {
      eventId: 'ev-aba',
      token: claimA.token,
      now: '2026-09-13T00:10:01.000Z',
    });
    expect(staleComplete).toBe(false);

    const event = await db
      .prepare('SELECT state FROM ingest_events WHERE event_id = ?')
      .bind('ev-aba')
      .first<{ state: string }>();
    expect(event?.state).toBe('RETRYABLE_FAILED');
  });
});
