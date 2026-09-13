import { describe, expect, it } from 'vitest';
import { createTestD1, loadG3Schema, seedBaselineAccounts } from '@pdos/testkit';

import {
  GMAIL_RATE_LIMIT_PER_MINUTE,
  GMAIL_RATE_WINDOW_CEILING,
  GMAIL_API_DAILY_CEILING,
  GMAIL_AI_NEURON_DAILY_CEILING,
  reserveGmailRateWindow,
  reserveGmailApiUnits,
  reserveGmailAiNeurons,
  reconcileGmailAiNeurons,
} from '../../src/gmail/quota.js';

// G3 checkpoint 6 (proposal §2.9). GPT-PM round 1 (2026-09-13, VERDICT: MAJOR, 0 BLOCKER / 5 MAJOR)
// required deriving every quota-partition key internally from a caller-supplied `now: string` ISO
// instant instead of trusting a bare caller-computed number/string, halving the rate-window's own
// per-bucket ceiling to close a boundary-burst gap, and redesigning the AI Neuron budget as an
// idempotent per-reservation ledger with a raw, associative running total instead of a single
// per-call-clamped aggregate. See quota.ts's own module header for the full reasoning this test
// suite verifies against.

const T0 = '2026-09-13T00:00:00.000Z';
const T0_PLUS_1MIN = '2026-09-13T00:01:00.000Z';
const NEXT_DAY = '2026-09-14T00:00:00.000Z';

describe('reserveGmailRateWindow', () => {
  it('reserves and creates the window row lazily, no manual reset needed', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    const result = await reserveGmailRateWindow(db, {
      gmailAccountId: accounts.gmailAccountId,
      now: T0,
      units: 2,
    });
    expect(result).toEqual({ reserved: true, unitsReserved: 2 });
  });

  it('reserves up to and including the exact per-bucket ceiling (half of GMAIL_RATE_LIMIT_PER_MINUTE)', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    let last;
    for (let i = 0; i < GMAIL_RATE_WINDOW_CEILING / 2; i++) {
      last = await reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        now: T0,
        units: 2,
      });
      expect(last.reserved).toBe(true);
    }
    expect(last).toEqual({ reserved: true, unitsReserved: GMAIL_RATE_WINDOW_CEILING });

    const overCap = await reserveGmailRateWindow(db, {
      gmailAccountId: accounts.gmailAccountId,
      now: T0,
      units: 1,
    });
    expect(overCap).toEqual({ reserved: false, unitsReserved: null });
  });

  it('the per-bucket ceiling is exactly half the real per-minute limit', () => {
    expect(GMAIL_RATE_WINDOW_CEILING).toBe(GMAIL_RATE_LIMIT_PER_MINUTE / 2);
  });

  it('never allows more than the real per-minute limit within any real 60-second span, even across an adjacent-bucket boundary burst (GPT-PM round 1 MAJOR finding #5)', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    // Adversarial worst case: one reservation 1ms before a minute boundary, the next 1ms after --
    // 2ms apart in real time, landing in two adjacent fixed buckets.
    const justBeforeBoundary = '2026-09-13T00:00:59.999Z';
    const justAfterBoundary = '2026-09-13T00:01:00.001Z';

    const first = await reserveGmailRateWindow(db, {
      gmailAccountId: accounts.gmailAccountId,
      now: justBeforeBoundary,
      units: GMAIL_RATE_WINDOW_CEILING,
    });
    const second = await reserveGmailRateWindow(db, {
      gmailAccountId: accounts.gmailAccountId,
      now: justAfterBoundary,
      units: GMAIL_RATE_WINDOW_CEILING,
    });
    expect(first.reserved).toBe(true);
    expect(second.reserved).toBe(true);
    // The two adjacent buckets together reach the real per-minute limit exactly, never more --
    // this is the provable property the halved per-bucket ceiling exists to guarantee.
    expect((first.unitsReserved ?? 0) + (second.unitsReserved ?? 0)).toBe(
      GMAIL_RATE_LIMIT_PER_MINUTE,
    );
  });

  it('respects a smaller runtime-configured cap below the per-bucket ceiling', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    for (let i = 0; i < 100; i++) {
      const result = await reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        now: T0,
        units: 1,
        cap: 100,
      });
      expect(result.reserved).toBe(true);
    }
    const blocked = await reserveGmailRateWindow(db, {
      gmailAccountId: accounts.gmailAccountId,
      now: T0,
      units: 1,
      cap: 100,
    });
    expect(blocked).toEqual({ reserved: false, unitsReserved: null });
  });

  it('keeps separate windows per (account, minute) -- a new minute is a fresh bucket', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    await reserveGmailRateWindow(db, {
      gmailAccountId: accounts.gmailAccountId,
      now: T0,
      units: GMAIL_RATE_WINDOW_CEILING,
    });
    const nextWindow = await reserveGmailRateWindow(db, {
      gmailAccountId: accounts.gmailAccountId,
      now: T0_PLUS_1MIN,
      units: 1,
    });
    expect(nextWindow).toEqual({ reserved: true, unitsReserved: 1 });
  });

  it('keeps separate windows per account within the same minute', async () => {
    const db = createTestD1(loadG3Schema());
    await seedBaselineAccounts(db); // seeds acc-gmail-test
    const secondAccountId = 'acc-gmail-second';
    await db
      .prepare(
        'INSERT INTO source_accounts (source_account_id, user_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(secondAccountId, 'u-test', 'gmail', T0, T0)
      .run();

    await reserveGmailRateWindow(db, {
      gmailAccountId: 'acc-gmail-test',
      now: T0,
      units: GMAIL_RATE_WINDOW_CEILING,
    });
    const otherAccount = await reserveGmailRateWindow(db, {
      gmailAccountId: secondAccountId,
      now: T0,
      units: 1,
    });
    expect(otherAccount).toEqual({ reserved: true, unitsReserved: 1 });
  });

  it('rejects a single reservation whose own units can never fit under cap, before touching the database', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    await expect(
      reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        now: T0,
        units: 101,
        cap: 100,
      }),
    ).rejects.toThrow(RangeError);

    const row = await db
      .prepare('SELECT units_reserved FROM gmail_rate_reservations WHERE gmail_account_id = ?')
      .bind(accounts.gmailAccountId)
      .first<{ units_reserved: number }>();
    expect(row).toBeNull();
  });

  it('rejects a cap above the per-bucket ceiling -- there is no way to opt back into the unhalved value', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    await expect(
      reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        now: T0,
        units: 1,
        cap: GMAIL_RATE_WINDOW_CEILING + 1,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects a non-positive or non-integer units value', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    await expect(
      reserveGmailRateWindow(db, { gmailAccountId: accounts.gmailAccountId, now: T0, units: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      reserveGmailRateWindow(db, { gmailAccountId: accounts.gmailAccountId, now: T0, units: 1.5 }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects an unparseable now string, before touching the database (GPT-PM round 1 MAJOR finding #3)', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    await expect(
      reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        now: 'not-a-date',
        units: 1,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects a Date.now()-shaped integer and a date-only string instead of treating either as an instant', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    await expect(
      reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        now: 1_757_000_000_123 as unknown as string,
        units: 1,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        now: '2026-09-13',
        units: 1,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        now: '2026-02-31T00:00:00Z',
        units: 1,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        now: '2026-09-13T00:00:00+14:01',
        units: 1,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('under genuinely CONCURRENT callers (Promise.all, never sequentially awaited), the per-bucket cap is never exceeded', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    const cap = 100;
    const calls = Array.from({ length: 150 }, () =>
      reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        now: T0,
        units: 1,
        cap,
      }),
    );
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.reserved).length).toBe(cap);

    const row = await db
      .prepare('SELECT units_reserved FROM gmail_rate_reservations WHERE gmail_account_id = ?')
      .bind(accounts.gmailAccountId)
      .first<{ units_reserved: number }>();
    expect(row?.units_reserved).toBe(cap);
  });
});

describe('reserveGmailApiUnits', () => {
  it('reserves and creates the day row lazily', async () => {
    const db = createTestD1(loadG3Schema());
    const result = await reserveGmailApiUnits(db, { now: T0, units: 2 });
    expect(result).toEqual({ reserved: true, unitsConsumed: 2 });
  });

  it('respects a smaller runtime-configured cap below the hard daily ceiling', async () => {
    const db = createTestD1(loadG3Schema());
    for (let i = 0; i < 50; i++) {
      const result = await reserveGmailApiUnits(db, { now: T0, units: 2, cap: 100 });
      expect(result.reserved).toBe(true);
    }
    const blocked = await reserveGmailApiUnits(db, { now: T0, units: 2, cap: 100 });
    expect(blocked).toEqual({ reserved: false, unitsConsumed: null });
  });

  it('keeps separate counters per UTC day', async () => {
    const db = createTestD1(loadG3Schema());
    await reserveGmailApiUnits(db, { now: T0, units: 500 });
    const otherDay = await reserveGmailApiUnits(db, { now: NEXT_DAY, units: 5 });
    expect(otherDay).toEqual({ reserved: true, unitsConsumed: 5 });
  });

  it('derives the daily partition from UTC even when the supplied instant uses another offset', async () => {
    const db = createTestD1(loadG3Schema());
    await reserveGmailApiUnits(db, { now: '2026-09-14T01:30:00+03:00', units: 40, cap: 50 });
    const sameUtcDay = await reserveGmailApiUnits(db, {
      now: '2026-09-13T22:31:00Z',
      units: 10,
      cap: 50,
    });
    expect(sameUtcDay).toEqual({ reserved: true, unitsConsumed: 50 });
    const blocked = await reserveGmailApiUnits(db, {
      now: '2026-09-13T23:00:00Z',
      units: 1,
      cap: 50,
    });
    expect(blocked).toEqual({ reserved: false, unitsConsumed: null });
  });

  it('reserves up to and including the exact real daily ceiling of 80,000,000, via large single-call reservations', async () => {
    const db = createTestD1(loadG3Schema());
    const first = await reserveGmailApiUnits(db, { now: T0, units: 79_999_998 });
    expect(first).toEqual({ reserved: true, unitsConsumed: 79_999_998 });

    const overCap = await reserveGmailApiUnits(db, { now: T0, units: 3 });
    expect(overCap).toEqual({ reserved: false, unitsConsumed: null });

    const exact = await reserveGmailApiUnits(db, { now: T0, units: 2 });
    expect(exact).toEqual({ reserved: true, unitsConsumed: GMAIL_API_DAILY_CEILING });
  });

  it('rejects a cap above the schema hard ceiling', async () => {
    const db = createTestD1(loadG3Schema());
    await expect(
      reserveGmailApiUnits(db, { now: T0, units: 1, cap: GMAIL_API_DAILY_CEILING + 1 }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects a single reservation whose own units can never fit under cap', async () => {
    const db = createTestD1(loadG3Schema());
    await expect(reserveGmailApiUnits(db, { now: T0, units: 101, cap: 100 })).rejects.toThrow(
      RangeError,
    );
  });

  it('rejects a non-positive or non-integer units value', async () => {
    const db = createTestD1(loadG3Schema());
    await expect(reserveGmailApiUnits(db, { now: T0, units: 0 })).rejects.toThrow(RangeError);
    await expect(reserveGmailApiUnits(db, { now: T0, units: 1.5 })).rejects.toThrow(RangeError);
  });

  it('rejects an unparseable now string', async () => {
    const db = createTestD1(loadG3Schema());
    await expect(reserveGmailApiUnits(db, { now: 'not-a-date', units: 1 })).rejects.toThrow(
      RangeError,
    );
  });

  it('under genuinely CONCURRENT callers, the daily project-wide cap is never exceeded', async () => {
    const db = createTestD1(loadG3Schema());
    const cap = 200;
    const calls = Array.from({ length: 250 }, () =>
      reserveGmailApiUnits(db, { now: T0, units: 1, cap }),
    );
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.reserved).length).toBe(cap);

    const row = await db
      .prepare('SELECT units_consumed FROM gmail_api_budget_counters WHERE day = ?')
      .bind('2026-09-13')
      .first<{ units_consumed: number }>();
    expect(row?.units_consumed).toBe(cap);
  });
});

describe('reserveGmailAiNeurons', () => {
  it('reserves and creates the day row lazily, returning a reservationId', async () => {
    const db = createTestD1(loadG3Schema());
    const result = await reserveGmailAiNeurons(db, { now: T0, neurons: 50 });
    expect(result.reserved).toBe(true);
    expect(result.neuronsReserved).toBe(50);
    expect(result.neuronsRequested).toBe(50);
    expect(typeof result.reservationId).toBe('string');
    expect(result.reservationId?.length).toBeGreaterThan(0);
  });

  it('each reservation gets its own distinct reservationId', async () => {
    const db = createTestD1(loadG3Schema());
    const first = await reserveGmailAiNeurons(db, { now: T0, neurons: 10 });
    const second = await reserveGmailAiNeurons(db, { now: T0, neurons: 10 });
    expect(first.reservationId).not.toBe(second.reservationId);
    expect(second.neuronsReserved).toBe(20); // cumulative day total
    expect(second.neuronsRequested).toBe(10); // this call's own amount
  });

  it('reserves up to and including the exact schema hard ceiling of 10000', async () => {
    const db = createTestD1(loadG3Schema());
    const first = await reserveGmailAiNeurons(db, { now: T0, neurons: 10000 });
    expect(first.reserved).toBe(true);
    expect(first.neuronsReserved).toBe(10000);

    const overCap = await reserveGmailAiNeurons(db, { now: T0, neurons: 1 });
    expect(overCap).toEqual({
      reserved: false,
      neuronsReserved: null,
      neuronsRequested: 1,
      reservationId: null,
    });

    const ledgerCount = await db
      .prepare('SELECT COUNT(*) AS count FROM gmail_ai_neuron_reservations')
      .first<{ count: number }>();
    expect(ledgerCount?.count).toBe(1);
  });

  it('creates the reservation and its aggregate contribution in one trigger-backed INSERT', async () => {
    const db = createTestD1(loadG3Schema());
    const result = await reserveGmailAiNeurons(db, { now: T0, neurons: 75 });

    const ledger = await db
      .prepare(
        `SELECT day, estimated_neurons, reconciled, created_at
         FROM gmail_ai_neuron_reservations WHERE reservation_id = ?`,
      )
      .bind(result.reservationId)
      .first<{
        day: string;
        estimated_neurons: number;
        reconciled: number;
        created_at: string;
      }>();
    const aggregate = await db
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind('2026-09-13')
      .first<{ neurons_reserved: number }>();

    expect(ledger).toEqual({
      day: '2026-09-13',
      estimated_neurons: 75,
      reconciled: 0,
      created_at: T0,
    });
    expect(aggregate?.neurons_reserved).toBe(75);
  });

  it('rejects a cap above the schema hard ceiling', async () => {
    const db = createTestD1(loadG3Schema());
    await expect(
      reserveGmailAiNeurons(db, { now: T0, neurons: 1, cap: GMAIL_AI_NEURON_DAILY_CEILING + 1 }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects a single reservation whose own neurons can never fit under cap', async () => {
    const db = createTestD1(loadG3Schema());
    await expect(reserveGmailAiNeurons(db, { now: T0, neurons: 101, cap: 100 })).rejects.toThrow(
      RangeError,
    );
  });

  it('rejects a non-positive or non-integer neurons value', async () => {
    const db = createTestD1(loadG3Schema());
    await expect(reserveGmailAiNeurons(db, { now: T0, neurons: 0 })).rejects.toThrow(RangeError);
    await expect(reserveGmailAiNeurons(db, { now: T0, neurons: 1.5 })).rejects.toThrow(RangeError);
  });

  it('rejects an unparseable now string', async () => {
    const db = createTestD1(loadG3Schema());
    await expect(reserveGmailAiNeurons(db, { now: 'not-a-date', neurons: 1 })).rejects.toThrow(
      RangeError,
    );
  });

  it('under genuinely CONCURRENT callers, the daily Neuron cap is never exceeded', async () => {
    const db = createTestD1(loadG3Schema());
    const cap = 100;
    const calls = Array.from({ length: 150 }, () =>
      reserveGmailAiNeurons(db, { now: T0, neurons: 1, cap }),
    );
    const results = await Promise.all(calls);
    const succeeded = results.filter((r) => r.reserved);
    expect(succeeded.length).toBe(cap);
    // Every successful concurrent reservation still got its own distinct reservationId.
    expect(new Set(succeeded.map((r) => r.reservationId)).size).toBe(cap);

    const row = await db
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind('2026-09-13')
      .first<{ neurons_reserved: number }>();
    expect(row?.neurons_reserved).toBe(cap);
  });
});

describe('reconcileGmailAiNeurons', () => {
  it('gives back unused margin when the conservative estimate over-reserved (the expected case)', async () => {
    const db = createTestD1(loadG3Schema());
    const reservation = await reserveGmailAiNeurons(db, { now: T0, neurons: 100 });
    const result = await reconcileGmailAiNeurons(db, {
      reservationId: reservation.reservationId!,
      actualNeurons: 40,
      now: T0,
    });
    expect(result).toEqual({ outcome: 'RECONCILED' });
    const row = await db
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind('2026-09-13')
      .first<{ neurons_reserved: number }>();
    expect(row?.neurons_reserved).toBe(40);
  });

  it('adds the extra on a rare under-estimate', async () => {
    const db = createTestD1(loadG3Schema());
    const reservation = await reserveGmailAiNeurons(db, { now: T0, neurons: 100 });
    await reconcileGmailAiNeurons(db, {
      reservationId: reservation.reservationId!,
      actualNeurons: 130,
      now: T0,
    });
    const row = await db
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind('2026-09-13')
      .first<{ neurons_reserved: number }>();
    expect(row?.neurons_reserved).toBe(130);
  });

  it('the raw total can legitimately exceed the daily cap after a genuine gross under-estimate -- no longer silently clamped (GPT-PM round 1 MAJOR finding #2)', async () => {
    const db = createTestD1(loadG3Schema());
    const reservation = await reserveGmailAiNeurons(db, { now: T0, neurons: 9990 });
    const result = await reconcileGmailAiNeurons(db, {
      reservationId: reservation.reservationId!,
      actualNeurons: 10490,
      now: T0,
    });
    expect(result).toEqual({ outcome: 'RECONCILED' });
    const row = await db
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind('2026-09-13')
      .first<{ neurons_reserved: number }>();
    // 9990 (reserved) - 9990 (estimated) + 10490 (actual) = 10490, above the 10000 cap -- visible,
    // not hidden. reserveGmailAiNeurons itself still refuses further reservations that day.
    expect(row?.neurons_reserved).toBe(10490);
    const refused = await reserveGmailAiNeurons(db, { now: T0, neurons: 1 });
    expect(refused.reserved).toBe(false);
  });

  it('reconciliation ORDER no longer affects the final total -- the exact defect GPT-PM round 1 found is fixed', async () => {
    // Same two logical reservations/reconciliations as the old (now-fixed) counter-example, run in
    // both orders -- both orders must now agree, proving the raw total is associative.
    const day = '2026-09-13';

    const dbAthenB = createTestD1(loadG3Schema());
    const rA1 = await reserveGmailAiNeurons(dbAthenB, { now: T0, neurons: 100 });
    const rB1 = await reserveGmailAiNeurons(dbAthenB, { now: T0, neurons: 100 });
    await reconcileGmailAiNeurons(dbAthenB, {
      reservationId: rA1.reservationId!,
      actualNeurons: 9950,
      now: T0,
    });
    await reconcileGmailAiNeurons(dbAthenB, {
      reservationId: rB1.reservationId!,
      actualNeurons: 0,
      now: T0,
    });
    const aThenB = await dbAthenB
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind(day)
      .first<{ neurons_reserved: number }>();

    const dbBthenA = createTestD1(loadG3Schema());
    const rA2 = await reserveGmailAiNeurons(dbBthenA, { now: T0, neurons: 100 });
    const rB2 = await reserveGmailAiNeurons(dbBthenA, { now: T0, neurons: 100 });
    await reconcileGmailAiNeurons(dbBthenA, {
      reservationId: rB2.reservationId!,
      actualNeurons: 0,
      now: T0,
    });
    await reconcileGmailAiNeurons(dbBthenA, {
      reservationId: rA2.reservationId!,
      actualNeurons: 9950,
      now: T0,
    });
    const bThenA = await dbBthenA
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind(day)
      .first<{ neurons_reserved: number }>();

    expect(aThenB?.neurons_reserved).toBe(9950);
    expect(bThenA?.neurons_reserved).toBe(9950);
    expect(aThenB?.neurons_reserved).toBe(bThenA?.neurons_reserved);
  });

  it('a repeated reconciliation for the same reservation is a no-op, not a double-application (GPT-PM round 1 MAJOR finding #1)', async () => {
    const db = createTestD1(loadG3Schema());
    const reservation = await reserveGmailAiNeurons(db, { now: T0, neurons: 100 });
    const first = await reconcileGmailAiNeurons(db, {
      reservationId: reservation.reservationId!,
      actualNeurons: 40,
      now: T0,
    });
    expect(first).toEqual({ outcome: 'RECONCILED' });

    // An ordinary Worker/message retry, or an operator re-invoking this by mistake.
    const second = await reconcileGmailAiNeurons(db, {
      reservationId: reservation.reservationId!,
      actualNeurons: 40,
      now: T0,
    });
    expect(second).toEqual({ outcome: 'ALREADY_RECONCILED' });

    const row = await db
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind('2026-09-13')
      .first<{ neurons_reserved: number }>();
    // Still 40, not 40-60-60=-80 (clamped to 0) or any other double-applied value.
    expect(row?.neurons_reserved).toBe(40);
  });

  it('a retried positive-delta reconciliation also applies the extra usage exactly once', async () => {
    const db = createTestD1(loadG3Schema());
    const reservation = await reserveGmailAiNeurons(db, { now: T0, neurons: 100 });
    const first = await reconcileGmailAiNeurons(db, {
      reservationId: reservation.reservationId!,
      actualNeurons: 130,
      now: T0,
    });
    const retry = await reconcileGmailAiNeurons(db, {
      reservationId: reservation.reservationId!,
      actualNeurons: 130,
      now: T0,
    });
    expect(first).toEqual({ outcome: 'RECONCILED' });
    expect(retry).toEqual({ outcome: 'ALREADY_RECONCILED' });

    const row = await db
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind('2026-09-13')
      .first<{ neurons_reserved: number }>();
    expect(row?.neurons_reserved).toBe(130);
  });

  it('under genuinely CONCURRENT duplicate reconciliation calls for the SAME reservation, exactly one wins', async () => {
    const db = createTestD1(loadG3Schema());
    const reservation = await reserveGmailAiNeurons(db, { now: T0, neurons: 100 });
    const calls = Array.from({ length: 10 }, () =>
      reconcileGmailAiNeurons(db, {
        reservationId: reservation.reservationId!,
        actualNeurons: 40,
        now: T0,
      }),
    );
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.outcome === 'RECONCILED').length).toBe(1);
    expect(results.filter((r) => r.outcome === 'ALREADY_RECONCILED').length).toBe(9);

    const row = await db
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind('2026-09-13')
      .first<{ neurons_reserved: number }>();
    expect(row?.neurons_reserved).toBe(40);
  });

  it('returns NOT_FOUND for a reservationId this table has never seen', async () => {
    const db = createTestD1(loadG3Schema());
    const result = await reconcileGmailAiNeurons(db, {
      reservationId: 'never-issued',
      actualNeurons: 40,
      now: T0,
    });
    expect(result).toEqual({ outcome: 'NOT_FOUND' });
  });

  it('rejects a negative actualNeurons before writing anything', async () => {
    const db = createTestD1(loadG3Schema());
    const reservation = await reserveGmailAiNeurons(db, { now: T0, neurons: 100 });
    await expect(
      reconcileGmailAiNeurons(db, {
        reservationId: reservation.reservationId!,
        actualNeurons: -1,
        now: T0,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects an empty reservationId', async () => {
    const db = createTestD1(loadG3Schema());
    await expect(
      reconcileGmailAiNeurons(db, { reservationId: '', actualNeurons: 1, now: T0 }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects a non-RFC-3339 reconciliation timestamp before changing the ledger', async () => {
    const db = createTestD1(loadG3Schema());
    const reservation = await reserveGmailAiNeurons(db, { now: T0, neurons: 100 });
    await expect(
      reconcileGmailAiNeurons(db, {
        reservationId: reservation.reservationId!,
        actualNeurons: 40,
        now: '2026-09-13',
      }),
    ).rejects.toThrow(RangeError);

    const row = await db
      .prepare(
        'SELECT reconciled, actual_neurons FROM gmail_ai_neuron_reservations WHERE reservation_id = ?',
      )
      .bind(reservation.reservationId)
      .first<{ reconciled: number; actual_neurons: number | null }>();
    expect(row).toEqual({ reconciled: 0, actual_neurons: null });
  });
});
