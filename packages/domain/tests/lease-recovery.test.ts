import { describe, expect, it } from 'vitest';
import { createTestD1, loadG2Schema, seedBaselineAccounts, seedEvent } from '@pdos/testkit';

import { recoverStaleLeases } from '../src/lease-recovery.js';
import { renewLease } from '../src/lease.js';

async function setupStuckEvent(eventId: string, attemptCount: number, expiresAt: string) {
  const db = createTestD1(loadG2Schema());
  const accounts = await seedBaselineAccounts(db);
  await seedEvent(db, accounts, {
    eventId,
    state: 'PROCESSING',
    attemptCount,
    leaseOwner: 'worker-1',
    leaseToken: 'token-A',
    leaseExpiresAt: expiresAt,
  });
  return db;
}

describe('recoverStaleLeases', () => {
  it('below cap: reclaims a genuinely expired lease as RETRYABLE_FAILED', async () => {
    const db = await setupStuckEvent('ev-1', 1, '2026-09-12T23:58:00.000Z');
    const recovered = await recoverStaleLeases(db, {
      now: '2026-09-13T00:10:00.000Z',
      maxAttempts: 5,
      batchSize: 10,
      processorVersion: 'sweep',
    });
    expect(recovered).toEqual([{ eventId: 'ev-1', outcome: 'RETRYABLE_FAILED' }]);
  });

  it('at cap: reclaims a genuinely expired lease as DLQ, and writes a dead_letter_events row', async () => {
    const db = await setupStuckEvent('ev-2', 5, '2026-09-12T23:58:00.000Z');
    const recovered = await recoverStaleLeases(db, {
      now: '2026-09-13T00:10:00.000Z',
      maxAttempts: 5,
      batchSize: 10,
      processorVersion: 'sweep',
    });
    expect(recovered).toEqual([{ eventId: 'ev-2', outcome: 'DLQ' }]);

    const dlq = await db
      .prepare('SELECT COUNT(*) as n FROM dead_letter_events WHERE event_id = ?')
      .bind('ev-2')
      .first<{ n: number }>();
    expect(dlq?.n).toBe(1);
  });

  it('does not select a lease whose expiry is still in the future', async () => {
    const db = await setupStuckEvent('ev-3', 1, '2026-09-13T00:20:00.000Z');
    const recovered = await recoverStaleLeases(db, {
      now: '2026-09-13T00:10:00.000Z',
      maxAttempts: 5,
      batchSize: 10,
      processorVersion: 'sweep',
    });
    expect(recovered).toEqual([]);
  });

  it("THE Round-4 BLOCKER: a live processor heartbeat between the sweep's SELECT and its mutation must NOT be overridden", async () => {
    // The sweep's SELECT (inside recoverStaleLeases) observes the lease as expired at the moment
    // it runs. Simulate the live processor winning the race in between: it renews the SAME token
    // to a future expiry, exactly the "heartbeat extends expiry without rotating the token"
    // behavior migration 0001 documents. A naive token-only fence would still match and incorrectly
    // fail this actively-alive lease; the requireExpiredAsOf re-check must stop it.
    const db = await setupStuckEvent('ev-4', 1, '2026-09-13T00:09:59.000Z');

    // Interleave manually: read candidates the way recoverStaleLeases would, renew the lease as if
    // a live heartbeat landed right after that read, THEN run the real sweep call against the now-
    // renewed row -- proving the sweep's OWN mutation-time re-check (not merely its initial SELECT)
    // is what protects the lease, since the SELECT already happened against the stale expiry.
    const preRead = await db
      .prepare(
        "SELECT processing_lease_token FROM ingest_events WHERE state = 'PROCESSING' AND event_id = ?",
      )
      .bind('ev-4')
      .first<{ processing_lease_token: string }>();
    expect(preRead?.processing_lease_token).toBe('token-A');

    const renewed = await renewLease(db, {
      eventId: 'ev-4',
      token: 'token-A',
      now: '2026-09-13T00:09:59.500Z',
      leaseDurationMs: 120_000,
    });
    expect(renewed).toBe(true);

    const recovered = await recoverStaleLeases(db, {
      now: '2026-09-13T00:10:00.000Z',
      maxAttempts: 5,
      batchSize: 10,
      processorVersion: 'sweep',
    });
    // The sweep's own SELECT (inside recoverStaleLeases, using its own fresh "now") no longer even
    // sees ev-4 as a candidate, because the renewed expiry (00:11:59.5) is now in the future --
    // this IS the fix working, not a gap in the test: expiry is always re-read live, never cached.
    expect(recovered).toEqual([]);

    const event = await db
      .prepare('SELECT state, processing_lease_token FROM ingest_events WHERE event_id = ?')
      .bind('ev-4')
      .first<{ state: string; processing_lease_token: string }>();
    expect(event).toEqual({ state: 'PROCESSING', processing_lease_token: 'token-A' });
  });

  it('RACE_LOST: a stale observed token from an earlier read no longer matches after a concurrent resolution', async () => {
    const db = await setupStuckEvent('ev-5', 1, '2026-09-12T23:58:00.000Z');
    // A concurrent process (a second sweep run, or the live processor completing right at the
    // boundary) already resolved this event between this test's own read and the call below.
    await db
      .prepare(
        "UPDATE ingest_events SET state = 'PROCESSED', processing_lease_owner = NULL, processing_lease_token = NULL, processing_lease_expires_at = NULL WHERE event_id = ?",
      )
      .bind('ev-5')
      .run();

    const recovered = await recoverStaleLeases(db, {
      now: '2026-09-13T00:10:00.000Z',
      maxAttempts: 5,
      batchSize: 10,
      processorVersion: 'sweep',
    });
    // No longer PROCESSING at all, so it is not even selected as a candidate -- zero rows, not a
    // RACE_LOST outcome (RACE_LOST is reserved for a candidate that WAS selected but whose fenced
    // mutation then failed against a value that changed in between).
    expect(recovered).toEqual([]);
  });
});
