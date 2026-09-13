import { afterEach, describe, expect, it, vi } from 'vitest';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import {
  createTestD1,
  loadG2Schema,
  seedBaselineAccounts,
  seedEvent,
  seedOutbox,
} from '@pdos/testkit';
import { recoverStaleLeases } from '@pdos/domain';

import { processMessage } from '../src/handler.js';
import type { EventProcessor } from '../src/processor.js';

const NOW = '2026-09-13T00:00:00.000Z';

async function setupAccepted(eventId: string) {
  const db = createTestD1(loadG2Schema());
  const accounts = await seedBaselineAccounts(db);
  await seedEvent(db, accounts, { eventId, state: 'ACCEPTED' });
  await seedOutbox(db, eventId, { state: 'DISPATCHED', dispatchedAt: NOW });
  return db;
}

describe('processMessage', () => {
  it('claims, processes successfully, and completes the event', async () => {
    const db = await setupAccepted('ev-1');
    const succeed: EventProcessor = async () => ({ outcome: 'SUCCESS' });

    const result = await processMessage(db, {
      eventId: 'ev-1',
      workerId: 'worker-1',
      now: NOW,
      process: succeed,
    });
    expect(result).toEqual({ claimed: true, transitioned: true });

    const event = await db
      .prepare('SELECT state FROM ingest_events WHERE event_id = ?')
      .bind('ev-1')
      .first<{ state: string }>();
    expect(event?.state).toBe('PROCESSED');
  });

  it('defaults to the no-op processor (always SUCCESS) when none is injected', async () => {
    const db = await setupAccepted('ev-2');
    const result = await processMessage(db, { eventId: 'ev-2', workerId: 'worker-1', now: NOW });
    expect(result).toEqual({ claimed: true, transitioned: true });
  });

  it('a thrown processor exception is treated as RETRYABLE_FAILURE, releasing the lease', async () => {
    const db = await setupAccepted('ev-3');
    const throwing: EventProcessor = async () => {
      throw new Error('boom');
    };
    const result = await processMessage(db, {
      eventId: 'ev-3',
      workerId: 'worker-1',
      now: NOW,
      process: throwing,
    });
    expect(result).toEqual({ claimed: true, transitioned: true, movedToDlq: false });

    const event = await db
      .prepare('SELECT state, processing_lease_token FROM ingest_events WHERE event_id = ?')
      .bind('ev-3')
      .first<{ state: string; processing_lease_token: string | null }>();
    expect(event).toEqual({ state: 'RETRYABLE_FAILED', processing_lease_token: null });
  });

  it('an explicit PERMANENT_FAILURE goes straight to DLQ, below the attempt cap', async () => {
    const db = await setupAccepted('ev-4');
    const permanentFail: EventProcessor = async () => ({
      outcome: 'PERMANENT_FAILURE',
      errorClass: 'ValidationError',
      errorCode: 'E_INVALID',
    });
    const result = await processMessage(db, {
      eventId: 'ev-4',
      workerId: 'worker-1',
      now: NOW,
      process: permanentFail,
    });
    expect(result).toEqual({ claimed: true, transitioned: true, movedToDlq: true });
  });

  it('does not claim (and does not run the processor) a row already PROCESSING under a live lease', async () => {
    const db = await setupAccepted('ev-5');
    let calls = 0;
    const countingProcessor: EventProcessor = async () => {
      calls++;
      return { outcome: 'SUCCESS' };
    };

    const first = await processMessage(db, {
      eventId: 'ev-5',
      workerId: 'worker-1',
      now: NOW,
      process: countingProcessor,
    });
    expect(first.claimed).toBe(true);

    // A second, concurrent/duplicate delivery of the SAME dispatch (Cloudflare Queue's
    // at-least-once guarantee) must be a safe no-op, not a second processing run.
    const second = await processMessage(db, {
      eventId: 'ev-5',
      workerId: 'worker-2',
      now: '2026-09-13T00:00:01.000Z',
      process: countingProcessor,
    });
    expect(second).toEqual({ claimed: false });
    expect(calls).toBe(1);
  });

  it('escalating attempts respects the configured maxAttempts cap', async () => {
    const db = createTestD1(loadG2Schema());
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, {
      eventId: 'ev-6',
      state: 'RETRYABLE_FAILED',
      attemptCount: 4,
      firstFailedAt: NOW,
    });
    // DISPATCHED, not RETRY_PENDING: claimLease now requires a claim to correspond to a dispatch
    // the reconciler actually authorized (GPT-PM BLOCKER, G2 gate review) -- RETRY_PENDING means
    // still sitting in its backoff window, not yet due for delivery.
    await seedOutbox(db, 'ev-6', { state: 'DISPATCHED', dispatchedAt: NOW });

    const alwaysFail: EventProcessor = async () => ({
      outcome: 'RETRYABLE_FAILURE',
      errorClass: 'NetworkError',
      errorCode: 'E_NET',
    });
    // This is the 5th attempt -- at the default maxAttempts (5), it must go to DLQ, not loop again.
    const result = await processMessage(db, {
      eventId: 'ev-6',
      workerId: 'worker-1',
      now: NOW,
      process: alwaysFail,
    });
    expect(result).toEqual({ claimed: true, transitioned: true, movedToDlq: true });
  });
});

describe('processMessage heartbeat (GPT-PM BLOCKER, G2 gate review)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a healthy heartbeat keeps renewing the lease, so the stale-lease-recovery sweep does not reclaim a genuinely slow-but-alive attempt', async () => {
    vi.useFakeTimers();
    const db = await setupAccepted('ev-hb-1');

    // Heartbeat fires every 500ms of (simulated) wall time; each tick reports a fresh timestamp
    // 500ms further along than the last -- independent of the fake-timer clock, exactly like the
    // real clock injected by default, just deterministic for this test.
    let simulatedNowMs = Date.parse(NOW);
    const heartbeatNow = () => {
      simulatedNowMs += 500;
      return new Date(simulatedNowMs).toISOString();
    };

    let resolveProcessing!: () => void;
    const stillProcessing = new Promise<void>((resolve) => {
      resolveProcessing = resolve;
    });
    const slowProcessor: EventProcessor = async () => {
      await stillProcessing;
      return { outcome: 'SUCCESS' };
    };

    const resultPromise = processMessage(db, {
      eventId: 'ev-hb-1',
      workerId: 'worker-1',
      now: NOW,
      leaseDurationMs: 1000,
      heartbeatIntervalMs: 500,
      heartbeatNow,
      process: slowProcessor,
    });

    // Let 5 heartbeat ticks land (2500ms of renewals) -- well past the ORIGINAL 1000ms lease
    // duration this attempt started with.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }

    // A sweep running "now" at the point the ORIGINAL (unrenewed) lease would already have
    // expired must find nothing to reclaim: the heartbeat has kept extending the real expiry.
    const recovered = await recoverStaleLeases(db, {
      now: new Date(Date.parse(NOW) + 2500).toISOString(),
      maxAttempts: 5,
      batchSize: 10,
      processorVersion: 'stale-lease-recovery-sweep',
    });
    expect(recovered).toEqual([]);

    const midEvent = await db
      .prepare('SELECT state FROM ingest_events WHERE event_id = ?')
      .bind('ev-hb-1')
      .first<{ state: string }>();
    expect(midEvent?.state).toBe('PROCESSING');

    resolveProcessing();
    const result = await resultPromise;
    expect(result).toEqual({ claimed: true, transitioned: true });

    const finalEvent = await db
      .prepare('SELECT state FROM ingest_events WHERE event_id = ?')
      .bind('ev-hb-1')
      .first<{ state: string }>();
    expect(finalEvent?.state).toBe('PROCESSED');
  });

  it("a lease reclaimed out from under a still-running attempt fires leaseLost, and the stale worker's eventual completion is a safe no-op", async () => {
    vi.useFakeTimers();
    const db = await setupAccepted('ev-hb-2');

    const heartbeatNow = () => new Date(Date.parse(NOW) + 500).toISOString();

    let leaseLostSeen = false;
    let resolveAborted!: () => void;
    const abortedSignal = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    // A cooperative processor: it does not finish until the lease is actually lost, mirroring the
    // real EventProcessor contract this signal exists for (see ClaimedEvent.leaseLost's own doc).
    const cooperativeProcessor: EventProcessor = (event) =>
      new Promise((resolve) => {
        event.leaseLost.addEventListener('abort', () => {
          leaseLostSeen = true;
          resolveAborted();
          resolve({
            outcome: 'RETRYABLE_FAILURE',
            errorClass: 'Aborted',
            errorCode: 'E_LEASE_LOST',
          });
        });
      });

    const resultPromise = processMessage(db, {
      eventId: 'ev-hb-2',
      workerId: 'worker-1',
      now: NOW,
      leaseDurationMs: 1000,
      heartbeatIntervalMs: 500,
      heartbeatNow,
      process: cooperativeProcessor,
    });

    // Before the first heartbeat tick fires, a stale-lease sweep reclaims this event out from
    // under it -- e.g. a genuinely much slower renewal than assumed, or an operator-triggered
    // recovery. The row is no longer PROCESSING by the time the heartbeat tries to renew it.
    const recovered = await recoverStaleLeases(db, {
      now: new Date(Date.parse(NOW) + 1001).toISOString(),
      maxAttempts: 5,
      batchSize: 10,
      processorVersion: 'stale-lease-recovery-sweep',
    });
    expect(recovered).toEqual([{ eventId: 'ev-hb-2', outcome: 'RETRYABLE_FAILED' }]);

    // The pending heartbeat tick now fires, finds the fence already lost, and aborts.
    await vi.advanceTimersByTimeAsync(500);
    await abortedSignal;
    expect(leaseLostSeen).toBe(true);

    const result = await resultPromise;
    // The stale worker's own eventual completion is a safe no-op: `failProcessing`'s token fence
    // no longer matches (the sweep already moved the event to RETRYABLE_FAILED under a cleared
    // token), so this must report transitioned: false, never silently "succeed" over the sweep's
    // own resolution.
    expect(result).toEqual({ claimed: true, transitioned: false, movedToDlq: false });

    const event = await db
      .prepare('SELECT state FROM ingest_events WHERE event_id = ?')
      .bind('ev-hb-2')
      .first<{ state: string }>();
    expect(event?.state).toBe('RETRYABLE_FAILED');
  });

  it('a transient D1 error during heartbeat renewal is caught, signals leaseLost, and produces no unhandled rejection (GPT-PM MAJOR, round 2)', async () => {
    vi.useFakeTimers();
    const rawDb = await setupAccepted('ev-hb-3');
    // Wraps the real db so the ONE statement `renewLease` issues throws, simulating a transient
    // D1/runtime error -- everything else (claimLease, failProcessing) passes through untouched.
    const throwingDb: D1Database = {
      prepare(sql: string): D1PreparedStatement {
        if (sql.includes('SET processing_lease_expires_at = ?')) {
          return {
            bind(): D1PreparedStatement {
              return this as unknown as D1PreparedStatement;
            },
            async run(): Promise<never> {
              throw new Error('simulated transient D1 error');
            },
          } as unknown as D1PreparedStatement;
        }
        return rawDb.prepare(sql);
      },
      batch: rawDb.batch.bind(rawDb),
      exec: rawDb.exec.bind(rawDb),
      withSession: rawDb.withSession.bind(rawDb),
      dump: rawDb.dump.bind(rawDb),
    } as D1Database;

    let leaseLostSeen = false;
    let resolveAborted!: () => void;
    const abortedSignal = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    const cooperativeProcessor: EventProcessor = (event) =>
      new Promise((resolve) => {
        event.leaseLost.addEventListener('abort', () => {
          leaseLostSeen = true;
          resolveAborted();
          resolve({
            outcome: 'RETRYABLE_FAILURE',
            errorClass: 'Aborted',
            errorCode: 'E_LEASE_LOST',
          });
        });
      });

    const resultPromise = processMessage(throwingDb, {
      eventId: 'ev-hb-3',
      workerId: 'worker-1',
      now: NOW,
      leaseDurationMs: 1000,
      heartbeatIntervalMs: 500,
      heartbeatNow: () => new Date(Date.parse(NOW) + 500).toISOString(),
      process: cooperativeProcessor,
    });

    // Vitest fails the run on any unhandled rejection -- this assertion is really "the heartbeat's
    // renewal error was caught", proven by the whole test completing at all, not just by this line.
    await vi.advanceTimersByTimeAsync(500);
    await abortedSignal;
    expect(leaseLostSeen).toBe(true);

    const result = await resultPromise;
    // Unlike the sweep-reclaim scenario above, nothing else ever actually touched the lease -- only
    // the RENEWAL attempt failed. The original token/state are untouched, so the eventual
    // failProcessing call (with the original claim's token) succeeds normally.
    expect(result).toEqual({ claimed: true, transitioned: true, movedToDlq: false });

    const event = await rawDb
      .prepare('SELECT state FROM ingest_events WHERE event_id = ?')
      .bind('ev-hb-3')
      .first<{ state: string }>();
    expect(event?.state).toBe('RETRYABLE_FAILED');
  });
});
