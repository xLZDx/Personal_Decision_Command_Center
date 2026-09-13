import { describe, expect, it } from 'vitest';
import { createTestD1, loadG2Schema } from '@pdos/testkit';

import { HARD_BUDGET_CEILING, reserveBudget } from '../src/budget.js';

describe('reserveBudget', () => {
  it('reserves and creates the day row lazily, no manual reset needed', async () => {
    const db = createTestD1(loadG2Schema());
    const result = await reserveBudget(db, { day: '2026-09-13', cap: 2500 });
    expect(result).toEqual({ reserved: true, dispatchedCount: 1 });
  });

  it('reserves up to and including an exact cap of 2500 (the schema hard ceiling)', async () => {
    const db = createTestD1(loadG2Schema());
    let last;
    for (let i = 0; i < 2500; i++) {
      last = await reserveBudget(db, { day: '2026-09-13', cap: 2500 });
      expect(last.reserved).toBe(true);
    }
    expect(last).toEqual({ reserved: true, dispatchedCount: 2500 });

    const overCap = await reserveBudget(db, { day: '2026-09-13', cap: 2500 });
    expect(overCap).toEqual({ reserved: false, dispatchedCount: null });
  });

  it('respects a smaller runtime-configured cap (2000) below the hard ceiling', async () => {
    const db = createTestD1(loadG2Schema());
    for (let i = 0; i < 2000; i++) {
      const result = await reserveBudget(db, { day: '2026-09-13', cap: 2000 });
      expect(result.reserved).toBe(true);
    }
    const blocked = await reserveBudget(db, { day: '2026-09-13', cap: 2000 });
    expect(blocked).toEqual({ reserved: false, dispatchedCount: null });

    const row = await db
      .prepare('SELECT dispatched_count FROM queue_budget_counters WHERE day = ?')
      .bind('2026-09-13')
      .first<{ dispatched_count: number }>();
    // The counter itself keeps counting real dispatches even though a lower cap blocked further
    // reservations -- it is not clamped to the configured cap.
    expect(row?.dispatched_count).toBe(2000);
  });

  it('keeps separate counters per day', async () => {
    const db = createTestD1(loadG2Schema());
    await reserveBudget(db, { day: '2026-09-13', cap: 2500 });
    const otherDay = await reserveBudget(db, { day: '2026-09-14', cap: 2500 });
    expect(otherDay).toEqual({ reserved: true, dispatchedCount: 1 });
  });

  it('rejects a cap above the schema hard ceiling before ever touching the database', async () => {
    const db = createTestD1(loadG2Schema());
    await expect(
      reserveBudget(db, { day: '2026-09-13', cap: HARD_BUDGET_CEILING + 1 }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects a non-positive or non-integer cap', async () => {
    const db = createTestD1(loadG2Schema());
    await expect(reserveBudget(db, { day: '2026-09-13', cap: 0 })).rejects.toThrow(RangeError);
    await expect(reserveBudget(db, { day: '2026-09-13', cap: 1.5 })).rejects.toThrow(RangeError);
  });
});
