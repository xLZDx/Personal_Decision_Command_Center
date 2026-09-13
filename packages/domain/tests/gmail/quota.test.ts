import { describe, expect, it } from 'vitest';
import { createTestD1, loadG3Schema, seedBaselineAccounts } from '@pdos/testkit';

import {
  GMAIL_RATE_WINDOW_CEILING,
  GMAIL_API_DAILY_CEILING,
  GMAIL_AI_NEURON_DAILY_CEILING,
  reserveGmailRateWindow,
  reserveGmailApiUnits,
  reserveGmailAiNeurons,
  reconcileGmailAiNeurons,
} from '../../src/gmail/quota.js';

// G3 checkpoint 6 (proposal §2.9): the same three atomic UPSERT-reservation resources the
// checkpoint proposal names, exercised the same way `budget.test.ts` exercises
// `reserveBudget`/`queue_budget_counters` -- plus, per the proposal's own testing obligations, a
// `Promise.all`-driven (never sequentially awaited) test proving the D1-shared reservation holds
// its ceiling under real interleaving.
//
// Internal review finding (checkpoint 6 round 1, functional-test-reviewer): the D1 test shim
// (packages/testkit/src/d1.ts) fully serializes every statement through one FIFO write queue, the
// same way real D1 serializes single statements -- so for a resource whose reservation is exactly
// ONE atomic UPSERT statement, these tests mainly prove that a future refactor into a non-atomic
// multi-statement (SELECT-then-UPDATE) reservation would still be caught (a genuine TOCTOU
// regression the shim's per-statement -- not per-logical-operation -- serialization reproduces).
// They are NOT a live demonstration that today's single-UPSERT fencing itself is race-free under
// real concurrent D1 callers, which sequential boundary tests plus the schema's own CHECK
// constraints already establish for two of the three resources.

describe('reserveGmailRateWindow', () => {
  it('reserves and creates the window row lazily, no manual reset needed', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    const result = await reserveGmailRateWindow(db, {
      gmailAccountId: accounts.gmailAccountId,
      windowStartEpochMinute: 1000,
      units: 2,
    });
    expect(result).toEqual({ reserved: true, unitsReserved: 2 });
  });

  it('reserves up to and including an exact cap of 6000 (the schema hard ceiling)', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    let last;
    for (let i = 0; i < 3000; i++) {
      last = await reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        windowStartEpochMinute: 1000,
        units: 2,
      });
      expect(last.reserved).toBe(true);
    }
    expect(last).toEqual({ reserved: true, unitsReserved: 6000 });

    const overCap = await reserveGmailRateWindow(db, {
      gmailAccountId: accounts.gmailAccountId,
      windowStartEpochMinute: 1000,
      units: 1,
    });
    expect(overCap).toEqual({ reserved: false, unitsReserved: null });
  });

  it('respects a smaller runtime-configured cap below the hard ceiling', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    for (let i = 0; i < 100; i++) {
      const result = await reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        windowStartEpochMinute: 1000,
        units: 1,
        cap: 100,
      });
      expect(result.reserved).toBe(true);
    }
    const blocked = await reserveGmailRateWindow(db, {
      gmailAccountId: accounts.gmailAccountId,
      windowStartEpochMinute: 1000,
      units: 1,
      cap: 100,
    });
    expect(blocked).toEqual({ reserved: false, unitsReserved: null });
  });

  it('keeps separate windows per (account, epoch-minute) -- a new minute is a fresh bucket', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    await reserveGmailRateWindow(db, {
      gmailAccountId: accounts.gmailAccountId,
      windowStartEpochMinute: 1000,
      units: 6000,
    });
    const nextWindow = await reserveGmailRateWindow(db, {
      gmailAccountId: accounts.gmailAccountId,
      windowStartEpochMinute: 1001,
      units: 1,
    });
    expect(nextWindow).toEqual({ reserved: true, unitsReserved: 1 });
  });

  it('keeps separate windows per account within the same epoch-minute', async () => {
    const db = createTestD1(loadG3Schema());
    await seedBaselineAccounts(db); // seeds acc-gmail-test
    const secondAccountId = 'acc-gmail-second';
    await db
      .prepare(
        'INSERT INTO source_accounts (source_account_id, user_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(
        secondAccountId,
        'u-test',
        'gmail',
        '2026-09-13T00:00:00.000Z',
        '2026-09-13T00:00:00.000Z',
      )
      .run();

    await reserveGmailRateWindow(db, {
      gmailAccountId: 'acc-gmail-test',
      windowStartEpochMinute: 1000,
      units: 6000,
    });
    const otherAccount = await reserveGmailRateWindow(db, {
      gmailAccountId: secondAccountId,
      windowStartEpochMinute: 1000,
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
        windowStartEpochMinute: 1000,
        units: 101,
        cap: 100,
      }),
    ).rejects.toThrow(RangeError);

    // Confirms "before touching the database": no row was created by the rejected call.
    const row = await db
      .prepare('SELECT units_reserved FROM gmail_rate_reservations WHERE gmail_account_id = ?')
      .bind(accounts.gmailAccountId)
      .first<{ units_reserved: number }>();
    expect(row).toBeNull();
  });

  it('rejects a cap above the schema hard ceiling', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    await expect(
      reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        windowStartEpochMinute: 1000,
        units: 1,
        cap: GMAIL_RATE_WINDOW_CEILING + 1,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects a non-positive or non-integer units value', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    await expect(
      reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        windowStartEpochMinute: 1000,
        units: 0,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        windowStartEpochMinute: 1000,
        units: 1.5,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects a negative or non-integer windowStartEpochMinute -- a ms-scale value must never silently defeat the window key (internal review MAJOR, checkpoint 6 round 1)', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    await expect(
      reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        windowStartEpochMinute: -1,
        units: 1,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        // A ms-scale value (e.g. bare Date.now()) rather than the required epoch-MINUTE --
        // rejected because it's non-integer here, but the real defect this guards is that any
        // caller mistake in this field silently creates a fresh never-repeated bucket per call.
        windowStartEpochMinute: 1_757_000_000_123.5,
        units: 1,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('under genuinely CONCURRENT callers (Promise.all, never sequentially awaited), the cap is never exceeded', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    const cap = 100;
    // 150 concurrent single-unit reservations against a 100-unit cap -- fired together, not
    // awaited one at a time. Regression protection: proves a future refactor into a non-atomic
    // (SELECT-then-UPDATE) reservation would still be caught, since the shim's per-statement FIFO
    // queue lets concurrently-fired SELECTs interleave ahead of any UPDATEs the way real D1 would.
    const calls = Array.from({ length: 150 }, () =>
      reserveGmailRateWindow(db, {
        gmailAccountId: accounts.gmailAccountId,
        windowStartEpochMinute: 1000,
        units: 1,
        cap,
      }),
    );
    const results = await Promise.all(calls);
    const succeeded = results.filter((r) => r.reserved).length;
    const failed = results.filter((r) => !r.reserved).length;
    expect(succeeded).toBe(cap);
    expect(failed).toBe(150 - cap);

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
    const result = await reserveGmailApiUnits(db, { day: '2026-09-13', units: 2 });
    expect(result).toEqual({ reserved: true, unitsConsumed: 2 });
  });

  it('respects a smaller runtime-configured cap below the hard daily ceiling', async () => {
    const db = createTestD1(loadG3Schema());
    for (let i = 0; i < 50; i++) {
      const result = await reserveGmailApiUnits(db, { day: '2026-09-13', units: 2, cap: 100 });
      expect(result.reserved).toBe(true);
    }
    const blocked = await reserveGmailApiUnits(db, { day: '2026-09-13', units: 2, cap: 100 });
    expect(blocked).toEqual({ reserved: false, unitsConsumed: null });
  });

  it('keeps separate counters per day', async () => {
    const db = createTestD1(loadG3Schema());
    await reserveGmailApiUnits(db, { day: '2026-09-13', units: 500 });
    const otherDay = await reserveGmailApiUnits(db, { day: '2026-09-14', units: 5 });
    expect(otherDay).toEqual({ reserved: true, unitsConsumed: 5 });
  });

  it('reserves up to and including the exact real daily ceiling of 80,000,000, via large single-call reservations (no 80M-iteration loop needed)', async () => {
    const db = createTestD1(loadG3Schema());
    const first = await reserveGmailApiUnits(db, { day: '2026-09-13', units: 79_999_998 });
    expect(first).toEqual({ reserved: true, unitsConsumed: 79_999_998 });

    const overCap = await reserveGmailApiUnits(db, { day: '2026-09-13', units: 3 });
    expect(overCap).toEqual({ reserved: false, unitsConsumed: null });

    const exact = await reserveGmailApiUnits(db, { day: '2026-09-13', units: 2 });
    expect(exact).toEqual({ reserved: true, unitsConsumed: GMAIL_API_DAILY_CEILING });
  });

  it('rejects a cap above the schema hard ceiling', async () => {
    const db = createTestD1(loadG3Schema());
    await expect(
      reserveGmailApiUnits(db, {
        day: '2026-09-13',
        units: 1,
        cap: GMAIL_API_DAILY_CEILING + 1,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects a single reservation whose own units can never fit under cap', async () => {
    const db = createTestD1(loadG3Schema());
    await expect(
      reserveGmailApiUnits(db, { day: '2026-09-13', units: 101, cap: 100 }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects a non-positive or non-integer units value', async () => {
    const db = createTestD1(loadG3Schema());
    await expect(reserveGmailApiUnits(db, { day: '2026-09-13', units: 0 })).rejects.toThrow(
      RangeError,
    );
    await expect(reserveGmailApiUnits(db, { day: '2026-09-13', units: 1.5 })).rejects.toThrow(
      RangeError,
    );
  });

  it('under genuinely CONCURRENT callers, the daily project-wide cap is never exceeded', async () => {
    const db = createTestD1(loadG3Schema());
    const cap = 200;
    const calls = Array.from({ length: 250 }, () =>
      reserveGmailApiUnits(db, { day: '2026-09-13', units: 1, cap }),
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
  it('reserves and creates the day row lazily, echoing back this call own requested amount', async () => {
    const db = createTestD1(loadG3Schema());
    const result = await reserveGmailAiNeurons(db, { day: '2026-09-13', neurons: 50 });
    expect(result).toEqual({ reserved: true, neuronsReserved: 50, neuronsRequested: 50 });
  });

  it('neuronsRequested (this call own amount) diverges from neuronsReserved (the day cumulative) on a second call -- the exact confusion the internal review flagged', async () => {
    const db = createTestD1(loadG3Schema());
    await reserveGmailAiNeurons(db, { day: '2026-09-13', neurons: 50 });
    const second = await reserveGmailAiNeurons(db, { day: '2026-09-13', neurons: 30 });
    expect(second).toEqual({ reserved: true, neuronsReserved: 80, neuronsRequested: 30 });
  });

  it('reserves up to and including the exact schema hard ceiling of 10000', async () => {
    const db = createTestD1(loadG3Schema());
    const first = await reserveGmailAiNeurons(db, { day: '2026-09-13', neurons: 10000 });
    expect(first).toEqual({ reserved: true, neuronsReserved: 10000, neuronsRequested: 10000 });

    const overCap = await reserveGmailAiNeurons(db, { day: '2026-09-13', neurons: 1 });
    expect(overCap).toEqual({ reserved: false, neuronsReserved: null, neuronsRequested: 1 });
  });

  it('rejects a cap above the schema hard ceiling', async () => {
    const db = createTestD1(loadG3Schema());
    await expect(
      reserveGmailAiNeurons(db, {
        day: '2026-09-13',
        neurons: 1,
        cap: GMAIL_AI_NEURON_DAILY_CEILING + 1,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects a single reservation whose own neurons can never fit under cap', async () => {
    const db = createTestD1(loadG3Schema());
    await expect(
      reserveGmailAiNeurons(db, { day: '2026-09-13', neurons: 101, cap: 100 }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects a non-positive or non-integer neurons value', async () => {
    const db = createTestD1(loadG3Schema());
    await expect(reserveGmailAiNeurons(db, { day: '2026-09-13', neurons: 0 })).rejects.toThrow(
      RangeError,
    );
    await expect(reserveGmailAiNeurons(db, { day: '2026-09-13', neurons: 1.5 })).rejects.toThrow(
      RangeError,
    );
  });

  it('under genuinely CONCURRENT callers, the daily Neuron cap is never exceeded', async () => {
    const db = createTestD1(loadG3Schema());
    const cap = 100;
    const calls = Array.from({ length: 150 }, () =>
      reserveGmailAiNeurons(db, { day: '2026-09-13', neurons: 1, cap }),
    );
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.reserved).length).toBe(cap);

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
    await reserveGmailAiNeurons(db, { day: '2026-09-13', neurons: 100 });
    await reconcileGmailAiNeurons(db, {
      day: '2026-09-13',
      estimatedNeurons: 100,
      actualNeurons: 40,
    });
    const row = await db
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind('2026-09-13')
      .first<{ neurons_reserved: number }>();
    expect(row?.neurons_reserved).toBe(40);
  });

  it('adds the extra on a rare under-estimate', async () => {
    const db = createTestD1(loadG3Schema());
    await reserveGmailAiNeurons(db, { day: '2026-09-13', neurons: 100 });
    await reconcileGmailAiNeurons(db, {
      day: '2026-09-13',
      estimatedNeurons: 100,
      actualNeurons: 130,
    });
    const row = await db
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind('2026-09-13')
      .first<{ neurons_reserved: number }>();
    expect(row?.neurons_reserved).toBe(130);
  });

  it('clamps at the schema ceiling instead of throwing when a real completed call pushes the day over 10000', async () => {
    const db = createTestD1(loadG3Schema());
    await reserveGmailAiNeurons(db, { day: '2026-09-13', neurons: 9990 });
    // The real AIProvider call already happened and used far more than the conservative
    // estimate -- reconciliation must record it without ever throwing over an already-completed
    // external call.
    await expect(
      reconcileGmailAiNeurons(db, {
        day: '2026-09-13',
        estimatedNeurons: 10,
        actualNeurons: 500,
      }),
    ).resolves.toBeUndefined();
    const row = await db
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind('2026-09-13')
      .first<{ neurons_reserved: number }>();
    expect(row?.neurons_reserved).toBe(GMAIL_AI_NEURON_DAILY_CEILING);
  });

  it('clamps at zero instead of going negative when actual usage is reported as less than 0 net', async () => {
    const db = createTestD1(loadG3Schema());
    await reserveGmailAiNeurons(db, { day: '2026-09-13', neurons: 10 });
    await reconcileGmailAiNeurons(db, {
      day: '2026-09-13',
      estimatedNeurons: 500,
      actualNeurons: 0,
    });
    const row = await db
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind('2026-09-13')
      .first<{ neurons_reserved: number }>();
    expect(row?.neurons_reserved).toBe(0);
  });

  it('is a silent no-op for a day with no prior reservation row', async () => {
    const db = createTestD1(loadG3Schema());
    await expect(
      reconcileGmailAiNeurons(db, {
        day: '2026-09-13',
        estimatedNeurons: 50,
        actualNeurons: 40,
      }),
    ).resolves.toBeUndefined();
    const row = await db
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind('2026-09-13')
      .first<{ neurons_reserved: number }>();
    expect(row).toBeNull();
  });

  it('rejects a negative estimatedNeurons/actualNeurons before writing anything', async () => {
    const db = createTestD1(loadG3Schema());
    await expect(
      reconcileGmailAiNeurons(db, {
        day: '2026-09-13',
        estimatedNeurons: -1,
        actualNeurons: 0,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      reconcileGmailAiNeurons(db, {
        day: '2026-09-13',
        estimatedNeurons: 0,
        actualNeurons: -1,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("rejects a cap outside [1, schema hard ceiling] before writing anything (internal review MAJOR, checkpoint 6 round 1: this cap was previously unvalidated, contradicting the function's own never-throw contract)", async () => {
    const db = createTestD1(loadG3Schema());
    await reserveGmailAiNeurons(db, { day: '2026-09-13', neurons: 100 });
    await expect(
      reconcileGmailAiNeurons(db, {
        day: '2026-09-13',
        estimatedNeurons: 100,
        actualNeurons: 50,
        cap: GMAIL_AI_NEURON_DAILY_CEILING + 1,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      reconcileGmailAiNeurons(db, {
        day: '2026-09-13',
        estimatedNeurons: 100,
        actualNeurons: 50,
        cap: 0,
      }),
    ).rejects.toThrow(RangeError);

    // Confirms "before writing anything": the rejected calls left the row untouched.
    const row = await db
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind('2026-09-13')
      .first<{ neurons_reserved: number }>();
    expect(row?.neurons_reserved).toBe(100);
  });

  it('honors a smaller runtime-configured cap passed via options, mirroring the three reserve functions own "configurable downward" tests', async () => {
    const db = createTestD1(loadG3Schema());
    await reserveGmailAiNeurons(db, { day: '2026-09-13', neurons: 40, cap: 50 });
    await reconcileGmailAiNeurons(db, {
      day: '2026-09-13',
      estimatedNeurons: 40,
      actualNeurons: 200,
      cap: 50,
    });
    const row = await db
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind('2026-09-13')
      .first<{ neurons_reserved: number }>();
    // Clamped to the smaller runtime cap (50), not the schema hard ceiling (10000).
    expect(row?.neurons_reserved).toBe(50);
  });

  it('documents (does not assert as correct) the known accepted concurrent-reconciliation ordering limitation: the same two logical reconciliations produce different final totals depending on arrival order', async () => {
    // This is the module's own documented residual risk (see quota.ts's header comment), not a
    // regression this test is meant to catch -- it exists to make the limitation concrete and
    // keep it honest against the real implementation rather than only asserted in prose.
    const dayA = '2026-09-13';
    const dayB = '2026-09-14';

    const dbAthenB = createTestD1(loadG3Schema());
    await reserveGmailAiNeurons(dbAthenB, { day: dayA, neurons: 100 });
    await reserveGmailAiNeurons(dbAthenB, { day: dayA, neurons: 100 }); // day total 200
    await reconcileGmailAiNeurons(dbAthenB, {
      day: dayA,
      estimatedNeurons: 100,
      actualNeurons: 9950,
    }); // A: would be 10050, clamps to 10000
    await reconcileGmailAiNeurons(dbAthenB, { day: dayA, estimatedNeurons: 100, actualNeurons: 0 }); // B: 10000 - 100 = 9900
    const aThenB = await dbAthenB
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind(dayA)
      .first<{ neurons_reserved: number }>();

    const dbBthenA = createTestD1(loadG3Schema());
    await reserveGmailAiNeurons(dbBthenA, { day: dayB, neurons: 100 });
    await reserveGmailAiNeurons(dbBthenA, { day: dayB, neurons: 100 }); // day total 200
    await reconcileGmailAiNeurons(dbBthenA, { day: dayB, estimatedNeurons: 100, actualNeurons: 0 }); // B: 200 - 100 = 100
    await reconcileGmailAiNeurons(dbBthenA, {
      day: dayB,
      estimatedNeurons: 100,
      actualNeurons: 9950,
    }); // A: 100 + 9850 = 9950, no clamp
    const bThenA = await dbBthenA
      .prepare('SELECT neurons_reserved FROM gmail_ai_neuron_budget WHERE day = ?')
      .bind(dayB)
      .first<{ neurons_reserved: number }>();

    expect(aThenB?.neurons_reserved).toBe(9900);
    expect(bThenA?.neurons_reserved).toBe(9950);
    // Same two logical reconciliations, two different final ledgers -- the exact non-associativity
    // documented in quota.ts's header comment. Both totals stay within [0, cap] (the one invariant
    // this function actually guarantees) -- neither run throws or exceeds the ceiling.
    expect(aThenB?.neurons_reserved).not.toBe(bThenA?.neurons_reserved);
  });
});
