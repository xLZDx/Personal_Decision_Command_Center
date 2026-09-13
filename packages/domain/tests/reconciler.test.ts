import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import {
  createTestD1,
  loadG2Schema,
  seedBaselineAccounts,
  seedEvent,
  seedOutbox,
} from '@pdos/testkit';

import { reconcileDispatch } from '../src/reconciler.js';

describe('reconcileDispatch', () => {
  it('dispatches an eligible candidate and reserves budget for it', async () => {
    const db = createTestD1(loadG2Schema());
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, { eventId: 'ev-1', state: 'ACCEPTED' });
    await seedOutbox(db, 'ev-1', { state: 'PENDING', nextAttemptAt: '2026-09-13T00:00:00.000Z' });

    const result = await reconcileDispatch(db, {
      now: '2026-09-13T00:05:00.000Z',
      day: '2026-09-13',
      cap: 2500,
      maxAttempts: 5,
      batchSize: 25,
      redispatchTimeoutMs: 300_000,
    });
    expect(result).toEqual({ dispatched: ['ev-1'], budgetExhausted: false });

    const outbox = await db
      .prepare('SELECT state, dispatch_count FROM processing_outbox WHERE event_id = ?')
      .bind('ev-1')
      .first<{ state: string; dispatch_count: number }>();
    expect(outbox).toEqual({ state: 'DISPATCHED', dispatch_count: 1 });

    const budget = await db
      .prepare('SELECT dispatched_count FROM queue_budget_counters WHERE day = ?')
      .bind('2026-09-13')
      .first<{ dispatched_count: number }>();
    expect(budget?.dispatched_count).toBe(1);
  });

  it('excludes CLOSED outbox rows and events at/over the attempt cap', async () => {
    const db = createTestD1(loadG2Schema());
    const accounts = await seedBaselineAccounts(db);

    await seedEvent(db, accounts, { eventId: 'ev-closed', state: 'PROCESSED' });
    await seedOutbox(db, 'ev-closed', {
      state: 'CLOSED',
      nextAttemptAt: '2026-09-13T00:00:00.000Z',
    });

    await seedEvent(db, accounts, {
      eventId: 'ev-at-cap',
      state: 'RETRYABLE_FAILED',
      attemptCount: 5,
      firstFailedAt: '2026-09-13T00:00:00.000Z',
    });
    await seedOutbox(db, 'ev-at-cap', {
      state: 'RETRY_PENDING',
      nextAttemptAt: '2026-09-13T00:00:00.000Z',
    });

    await seedEvent(db, accounts, { eventId: 'ev-not-due', state: 'ACCEPTED' });
    await seedOutbox(db, 'ev-not-due', {
      state: 'PENDING',
      nextAttemptAt: '2026-09-13T01:00:00.000Z',
    });

    const result = await reconcileDispatch(db, {
      now: '2026-09-13T00:05:00.000Z',
      day: '2026-09-13',
      cap: 2500,
      maxAttempts: 5,
      batchSize: 25,
      redispatchTimeoutMs: 300_000,
    });
    expect(result).toEqual({ dispatched: [], budgetExhausted: false });
  });

  it('HARD_ZERO: once budget is exhausted, every remaining eligible candidate is deferred this cycle, none dispatched', async () => {
    const db = createTestD1(loadG2Schema());
    const accounts = await seedBaselineAccounts(db);
    await reserveUpTo(db, 2);
    // 3 eligible events with only 1 budget slot left this "day" (cap 3, 2 already reserved).
    for (const id of ['ev-1', 'ev-2', 'ev-3']) {
      await seedEvent(db, accounts, { eventId: id, state: 'ACCEPTED' });
      await seedOutbox(db, id, { state: 'PENDING', nextAttemptAt: '2026-09-13T00:00:00.000Z' });
    }

    const result = await reconcileDispatch(db, {
      now: '2026-09-13T00:05:00.000Z',
      day: '2026-09-13',
      cap: 3,
      maxAttempts: 5,
      batchSize: 25,
      redispatchTimeoutMs: 300_000,
    });
    // 1 slot remained (2 already reserved out of cap 3) -- exactly one of the three candidates
    // dispatches, the rest are deferred, and the loop reports the cycle as budget-exhausted.
    expect(result.dispatched).toHaveLength(1);
    expect(result.budgetExhausted).toBe(true);

    const deferredCount = await db
      .prepare("SELECT COUNT(*) as n FROM processing_outbox WHERE state = 'BUDGET_DEFERRED'")
      .first<{ n: number }>();
    expect(deferredCount?.n).toBe(2);
  });

  it('BLOCKER regression (database review, G2): two overlapping invocations racing the same candidate produce exactly one DISPATCHED row, never a double dispatch', async () => {
    const db = createTestD1(loadG2Schema());
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, { eventId: 'ev-race', state: 'ACCEPTED' });
    await seedOutbox(db, 'ev-race', {
      state: 'PENDING',
      nextAttemptAt: '2026-09-13T00:00:00.000Z',
    });

    const run = () =>
      reconcileDispatch(db, {
        now: '2026-09-13T00:05:00.000Z',
        day: '2026-09-13',
        cap: 2500,
        maxAttempts: 5,
        batchSize: 25,
        redispatchTimeoutMs: 300_000,
      });

    // Two "overlapping" invocations against the SAME candidate -- before the fix, both matched the
    // old `state <> 'CLOSED'` guard regardless of who had already dispatched it, so both would mark
    // the row DISPATCHED (incrementing dispatch_count twice) and both would report it in their own
    // `dispatched` array, which the caller (services/ingest's scheduled handler) would then send to
    // the real Queue TWICE for the same event.
    const [a, b] = await Promise.all([run(), run()]);
    const totalDispatched = [...a.dispatched, ...b.dispatched];
    expect(totalDispatched).toEqual(['ev-race']);

    const outbox = await db
      .prepare('SELECT state, dispatch_count FROM processing_outbox WHERE event_id = ?')
      .bind('ev-race')
      .first<{ state: string; dispatch_count: number }>();
    expect(outbox).toEqual({ state: 'DISPATCHED', dispatch_count: 1 });
  });

  it('BLOCKER regression: a losing invocation can never clobber an already-DISPATCHED row back to BUDGET_DEFERRED', async () => {
    const db = createTestD1(loadG2Schema());
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, { eventId: 'ev-dispatched', state: 'ACCEPTED' });
    await seedOutbox(db, 'ev-dispatched', {
      state: 'DISPATCHED',
      dispatchedAt: '2026-09-13T00:00:00.000Z',
    });

    // A second invocation somehow re-selects this event (e.g. it was still eligible under an
    // earlier, looser candidate query) and, having exhausted its own budget, attempts to defer it.
    // The fenced UPDATE must be a no-op against a row that is no longer in a pre-dispatch state.
    await db
      .prepare(
        "UPDATE processing_outbox SET state = 'BUDGET_DEFERRED', updated_at = ? WHERE event_id = ? AND state IN ('PENDING', 'RETRY_PENDING', 'BUDGET_DEFERRED')",
      )
      .bind('2026-09-13T00:05:00.000Z', 'ev-dispatched')
      .run();

    const outbox = await db
      .prepare('SELECT state FROM processing_outbox WHERE event_id = ?')
      .bind('ev-dispatched')
      .first<{ state: string }>();
    expect(outbox?.state).toBe('DISPATCHED');
  });

  it('BLOCKER regression (G2 gate review): a DISPATCHED row a Queue send() never delivered (or a message Cloudflare silently dropped) becomes eligible for redispatch once redispatchTimeoutMs has elapsed, with dispatch_count fenced to the observed value', async () => {
    const db = createTestD1(loadG2Schema());
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, { eventId: 'ev-lost-send', state: 'ACCEPTED' });
    await seedOutbox(db, 'ev-lost-send', {
      state: 'DISPATCHED',
      dispatchCount: 1,
      dispatchedAt: '2026-09-13T00:00:00.000Z',
      nextAttemptAt: '2026-09-13T00:05:00.000Z',
    });

    // Still within the redispatch window: not yet due.
    const tooSoon = await reconcileDispatch(db, {
      now: '2026-09-13T00:04:00.000Z',
      day: '2026-09-13',
      cap: 2500,
      maxAttempts: 5,
      batchSize: 25,
      redispatchTimeoutMs: 300_000,
    });
    expect(tooSoon.dispatched).toEqual([]);

    // Past the redispatch window: the reconciler treats the original dispatch as lost and issues a
    // fresh one, incrementing dispatch_count and advancing next_attempt_at again -- this is how the
    // pipeline eventually reaches PROCESSED even after a Queue.send() that threw post-D1-transition
    // or a message Cloudflare otherwise never delivered.
    const due = await reconcileDispatch(db, {
      now: '2026-09-13T00:05:01.000Z',
      day: '2026-09-13',
      cap: 2500,
      maxAttempts: 5,
      batchSize: 25,
      redispatchTimeoutMs: 300_000,
    });
    expect(due.dispatched).toEqual(['ev-lost-send']);

    const outbox = await db
      .prepare(
        'SELECT state, dispatch_count, next_attempt_at FROM processing_outbox WHERE event_id = ?',
      )
      .bind('ev-lost-send')
      .first<{ state: string; dispatch_count: number; next_attempt_at: string }>();
    expect(outbox?.state).toBe('DISPATCHED');
    expect(outbox?.dispatch_count).toBe(2);
    expect(outbox?.next_attempt_at).toBe('2026-09-13T00:10:01.000Z');
  });
});

async function reserveUpTo(db: D1Database, n: number) {
  for (let i = 0; i < n; i++) {
    await db
      .prepare(
        `INSERT INTO queue_budget_counters (day, dispatched_count) VALUES (?, 1)
         ON CONFLICT(day) DO UPDATE SET dispatched_count = dispatched_count + 1
         RETURNING dispatched_count`,
      )
      .bind('2026-09-13')
      .run();
  }
}
