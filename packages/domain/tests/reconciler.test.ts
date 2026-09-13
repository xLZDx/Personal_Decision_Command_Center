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
