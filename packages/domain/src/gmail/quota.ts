import type { D1Database } from '@cloudflare/workers-types';

/**
 * G3 checkpoint 6 (proposal §2.9): three independent D1-shared atomic reservation primitives for
 * the three separate quota resources a real Gmail sync/AI pipeline consumes. All three mirror
 * `packages/domain/src/budget.ts`'s `reserveBudget` -- the same self-bootstrapping
 * `INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING` UPSERT discipline, so "the row doesn't
 * exist yet" and "the resource is genuinely at cap" are the only two branches, and only the second
 * one returns zero rows. This is deliberately the SAME shared-D1 shape `queue_budget_counters`
 * already proved out, not a new mechanism -- the proposal's own round-3 MAJOR (an in-memory token
 * bucket cannot hold under Cloudflare Worker isolates, which do not share memory and are not
 * guaranteed request affinity) is exactly what motivates using D1, not isolate memory, as the
 * shared source of truth here too.
 *
 * These are PRIMITIVES only -- wiring them into an actual `GmailHistoryClient`/`AIProvider`
 * implementation is the not-yet-built `services/gmail-connector` Worker's job (a later checkpoint),
 * the same relationship checkpoint 1's push-lease and checkpoint 3's KEK crypto already have to
 * their own eventual callers.
 *
 * Known, accepted residual risk (internal review, checkpoint 6 round 1): `reconcileGmailAiNeurons`'s
 * clamp (`MAX(0, MIN(cap, neurons_reserved + delta))`) is not associative under concurrent
 * reconciliations of the SAME day -- if reconciliation A's own delta alone would have pushed the
 * running total past `cap` (or below 0) while B's would not, the FINAL recorded total after both
 * have applied depends on which one D1 serializes first, even though B's own delta never itself
 * crossed a clamp boundary. Worked counter-example: day total 200 (two 100-Neuron reservations, cap
 * 10000); A reconciles to actual=9950 (delta +9850, would clamp to 10000 alone), B reconciles to
 * actual=0 (delta -100). A-then-B ends at 9900; B-then-A ends at 9950 -- same two logical operations,
 * two different final ledgers. This is a bounded-drift, never-throws-and-never-exceeds-cap defect
 * (the function's one hard invariant -- never crash over an already-completed external AI call --
 * still holds in every order), not an unbounded or safety-relevant one: the true drift after any one
 * miscalibration event is bounded by that event's own over/under-estimate size, self-limits (no
 * further clamp collisions once the running total is back within range), and this ledger is a
 * proactive fail-closed coordination signal for the `NoAIProvider` degrade path, not the actual
 * enforcement of Workers AI's own real daily Neuron allocation (Cloudflare's platform is the true
 * backstop). Closing this fully would require tracking a raw, never-clamped running total in a
 * separate column and clamping only at read time for admission decisions -- a real schema/design
 * change, deliberately not made unilaterally here; surfaced to GPT-PM in this gate's own round-1
 * review rather than silently accepted or silently redesigned.
 */

/** Gmail API's own per-account short-window ceiling (EXTERNAL_ASSUMPTIONS.md §D, verified against
 *  `developers.google.com/workspace/gmail/api/reference/quota`). Rolling via a fixed 60-second
 *  epoch-minute bucket rather than a true sliding window -- the proposal's own accepted design,
 *  simpler than a sliding window and still holds Google's real ceiling with margin at personal
 *  scale (`EXTERNAL_ASSUMPTIONS.md`'s own worked example: ~576 units/day at a 5-minute poll
 *  cadence, nowhere near saturating even one 60-second bucket). */
export const GMAIL_RATE_WINDOW_CEILING = 6000;

/** Gmail API's own project-wide daily ceiling (EXTERNAL_ASSUMPTIONS.md §D). */
export const GMAIL_API_DAILY_CEILING = 80_000_000;

/** Workers AI's own free daily Neuron allocation (EXTERNAL_ASSUMPTIONS.md §C, ADR-010 HARD_ZERO).
 *  A SEPARATE resource from the two Gmail API ceilings above -- a Workers AI call consumes
 *  Neurons, not a Gmail API unit. */
export const GMAIL_AI_NEURON_DAILY_CEILING = 10_000;

/** Known Gmail API call costs, in quota units (EXTERNAL_ASSUMPTIONS.md §D). The proposal's own
 *  §2.9 budget model: `history.list` (2) + `messages.get` (20) per new message, `watch`/
 *  `renewWatch` (100) periodically, bounded 404-recovery `messages.list` (5). */
export const GMAIL_API_UNIT_COST = {
  HISTORY_LIST: 2,
  MESSAGES_GET: 20,
  WATCH: 100,
  MESSAGES_LIST_RECOVERY: 5,
} as const;

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer, got ${value}`);
  }
}

/** Internal review finding (checkpoint 6 round 1): unlike `units`/`neurons`/`cap`, the window-key
 *  itself had no runtime validation anywhere in this file -- a caller passing a millisecond-scale
 *  value (forgetting the `Math.floor(Date.now() / 60000)` this option's own doc comment prescribes)
 *  would silently create a fresh, never-repeated bucket key on every call, defeating the entire
 *  60-second rate ceiling with no error and no signal. Allows 0 (a valid epoch-minute value). */
function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got ${value}`);
  }
}

// ---------------------------------------------------------------------------------------------
// gmail_rate_reservations -- 60-second window, per gmail_account_id (6,000 units/min ceiling)
// ---------------------------------------------------------------------------------------------

export interface ReserveGmailRateWindowOptions {
  gmailAccountId: string;
  /** Epoch time in whole minutes (`Math.floor(Date.now() / 60000)`), not milliseconds -- the
   *  window's own bucket key. Validated as a non-negative integer; a caller passing a
   *  millisecond-scale value in error is a RangeError, not a silently-defeated rate ceiling. */
  windowStartEpochMinute: number;
  units: number;
  /** The schema's own absolute, non-configurable ceiling is `GMAIL_RATE_WINDOW_CEILING`; the
   *  actual EFFECTIVE cap may be set lower (never higher) without a schema change, same
   *  "configurable downward without review" rule `budget.ts`'s own `cap` already follows. */
  cap?: number;
}

export interface ReserveGmailRateWindowResult {
  reserved: boolean;
  unitsReserved: number | null;
}

/**
 * A single reservation whose OWN `units` already exceeds `cap` can never succeed regardless of the
 * window's current state -- validated up front and thrown as a caller/config error (RangeError),
 * the same class of validation `budget.ts`'s own `cap` range check already uses, NOT a runtime
 * "wait for the next window" refusal. Every known real cost (`GMAIL_API_UNIT_COST`, max 100) sits
 * far below either ceiling, so this should only ever fire on a genuine caller bug. Without this
 * guard, the UPSERT's plain INSERT branch (the "no row yet" case) would insert `units` directly,
 * UNCHECKED against `cap` -- `budget.ts`'s own `reserveBudget` has the identical property, safe
 * there only because its caller always reserves exactly 1 at a time.
 */
export async function reserveGmailRateWindow(
  db: D1Database,
  opts: ReserveGmailRateWindowOptions,
): Promise<ReserveGmailRateWindowResult> {
  const cap = opts.cap ?? GMAIL_RATE_WINDOW_CEILING;
  if (!Number.isInteger(cap) || cap < 1 || cap > GMAIL_RATE_WINDOW_CEILING) {
    throw new RangeError(
      `Gmail rate-window cap must be an integer in [1, ${GMAIL_RATE_WINDOW_CEILING}], got ${cap}`,
    );
  }
  assertNonNegativeInteger(opts.windowStartEpochMinute, 'windowStartEpochMinute');
  assertPositiveInteger(opts.units, 'units');
  if (opts.units > cap) {
    throw new RangeError(
      `A single reservation of ${opts.units} units can never fit under cap ${cap}`,
    );
  }

  const row = await db
    .prepare(
      `INSERT INTO gmail_rate_reservations (gmail_account_id, window_start_epoch_minute, units_reserved)
       VALUES (?, ?, ?)
       ON CONFLICT (gmail_account_id, window_start_epoch_minute) DO UPDATE SET
         units_reserved = units_reserved + ?
         WHERE units_reserved + ? <= ?
       RETURNING units_reserved`,
    )
    .bind(opts.gmailAccountId, opts.windowStartEpochMinute, opts.units, opts.units, opts.units, cap)
    .first<{ units_reserved: number }>();

  if (!row) return { reserved: false, unitsReserved: null };
  return { reserved: true, unitsReserved: row.units_reserved };
}

// ---------------------------------------------------------------------------------------------
// gmail_api_budget_counters -- project-wide daily Gmail API unit ceiling
// ---------------------------------------------------------------------------------------------

export interface ReserveGmailApiUnitsOptions {
  day: string;
  units: number;
  cap?: number;
}

export interface ReserveGmailApiUnitsResult {
  reserved: boolean;
  unitsConsumed: number | null;
}

export async function reserveGmailApiUnits(
  db: D1Database,
  opts: ReserveGmailApiUnitsOptions,
): Promise<ReserveGmailApiUnitsResult> {
  const cap = opts.cap ?? GMAIL_API_DAILY_CEILING;
  if (!Number.isInteger(cap) || cap < 1 || cap > GMAIL_API_DAILY_CEILING) {
    throw new RangeError(
      `Gmail API daily cap must be an integer in [1, ${GMAIL_API_DAILY_CEILING}], got ${cap}`,
    );
  }
  assertPositiveInteger(opts.units, 'units');
  if (opts.units > cap) {
    throw new RangeError(
      `A single reservation of ${opts.units} units can never fit under cap ${cap}`,
    );
  }

  const row = await db
    .prepare(
      `INSERT INTO gmail_api_budget_counters (day, units_consumed) VALUES (?, ?)
       ON CONFLICT (day) DO UPDATE SET units_consumed = units_consumed + ?
         WHERE units_consumed + ? <= ?
       RETURNING units_consumed`,
    )
    .bind(opts.day, opts.units, opts.units, opts.units, cap)
    .first<{ units_consumed: number }>();

  if (!row) return { reserved: false, unitsConsumed: null };
  return { reserved: true, unitsConsumed: row.units_consumed };
}

// ---------------------------------------------------------------------------------------------
// gmail_ai_neuron_budget -- daily Workers AI Neuron ceiling, reserved BEFORE each call, reconciled
// AFTER (the real usage is not known with certainty until the call returns).
// ---------------------------------------------------------------------------------------------

export interface ReserveGmailAiNeuronsOptions {
  day: string;
  /** A conservative (deliberately over-, never under-) estimate for the selected model, reserved
   *  BEFORE the real `AIProvider` call -- the proposal's own required ordering: a reservation that
   *  cannot be granted fails closed to the `NoAIProvider` degrade path, never calls the provider
   *  un-reserved. The exact per-model estimate is a separate, not-yet-established task (this
   *  module only provides the reservation primitive, not the estimate table). */
  neurons: number;
  cap?: number;
}

export interface ReserveGmailAiNeuronsResult {
  reserved: boolean;
  /** The DAY'S CUMULATIVE total after this reservation, not this call's own amount -- same
   *  cumulative-return convention as `unitsReserved`/`unitsConsumed` above. Do NOT pass this value
   *  as `reconcileGmailAiNeurons`'s `estimatedNeurons` -- use `neuronsRequested` (this call's own
   *  amount) below instead (internal review finding, checkpoint 6 round 1: the two are easy to
   *  confuse, and passing the cumulative total where the per-call estimate belongs corrupts the
   *  whole day's ledger in one reconcile call). */
  neuronsReserved: number | null;
  /** Echoes `opts.neurons` -- THIS call's own per-call amount, always present regardless of whether
   *  the reservation succeeded, so a caller has the exact right value in scope to later pass as
   *  `reconcileGmailAiNeurons`'s `estimatedNeurons` without having to keep `opts.neurons` around
   *  separately or risk reaching for `neuronsReserved` (the cumulative total) by mistake. */
  neuronsRequested: number;
}

export async function reserveGmailAiNeurons(
  db: D1Database,
  opts: ReserveGmailAiNeuronsOptions,
): Promise<ReserveGmailAiNeuronsResult> {
  const cap = opts.cap ?? GMAIL_AI_NEURON_DAILY_CEILING;
  if (!Number.isInteger(cap) || cap < 1 || cap > GMAIL_AI_NEURON_DAILY_CEILING) {
    throw new RangeError(
      `Gmail AI Neuron daily cap must be an integer in [1, ${GMAIL_AI_NEURON_DAILY_CEILING}], got ${cap}`,
    );
  }
  assertPositiveInteger(opts.neurons, 'neurons');
  if (opts.neurons > cap) {
    throw new RangeError(
      `A single reservation of ${opts.neurons} Neurons can never fit under cap ${cap}`,
    );
  }

  const row = await db
    .prepare(
      `INSERT INTO gmail_ai_neuron_budget (day, neurons_reserved) VALUES (?, ?)
       ON CONFLICT (day) DO UPDATE SET neurons_reserved = neurons_reserved + ?
         WHERE neurons_reserved + ? <= ?
       RETURNING neurons_reserved`,
    )
    .bind(opts.day, opts.neurons, opts.neurons, opts.neurons, cap)
    .first<{ neurons_reserved: number }>();

  if (!row) return { reserved: false, neuronsReserved: null, neuronsRequested: opts.neurons };
  return { reserved: true, neuronsReserved: row.neurons_reserved, neuronsRequested: opts.neurons };
}

export interface ReconcileGmailAiNeuronsOptions {
  day: string;
  /** THIS call's own per-call estimate that was reserved (`reserveGmailAiNeurons`'s
   *  `neuronsRequested` echo, or the `opts.neurons` value passed to that call) -- NEVER
   *  `neuronsReserved` (the day's cumulative total; see that field's own doc comment). */
  estimatedNeurons: number;
  /** The real usage, when the `AIProvider` response exposes it. A conservative estimate makes
   *  `actualNeurons < estimatedNeurons` the expected case -- this call gives back the unused
   *  margin so the day's tracked total moves toward real usage rather than staying at the safety
   *  margin. See this module's own header comment for the accepted concurrent-reconciliation
   *  ordering limitation this adjustment is subject to. */
  actualNeurons: number;
  /** Same meaning and same "configurable downward without review" rule as every sibling `cap` in
   *  this file -- kept in the options object for shape parity with the three reserve functions
   *  (internal review finding, checkpoint 6 round 1: an earlier draft took this as a bare
   *  positional parameter with no validation at all, inconsistent with every other function here
   *  and untested). */
  cap?: number;
}

/**
 * Adjusts the day's running total by `actualNeurons - estimatedNeurons` (negative when the
 * estimate over-reserved, as expected; positive on a rare under-estimate). Deliberately NOT
 * gated by the schema's own `CHECK (neurons_reserved <= 10000)` the way reservation is -- the
 * real `AIProvider` call has ALREADY happened and consumed real Neurons by the time reconciliation
 * runs, regardless of what this table says, so a constraint violation here would throw AFTER a
 * genuinely successful operation completed, for a purely internal bookkeeping table. Clamped to
 * `[0, cap]` instead: an under-estimate that pushes the true total past the daily ceiling is a
 * real, alert-worthy miscalibration of the per-model estimate, but it is not this function's job
 * to fail an already-completed request over it -- it floors/ceilings the recorded value and lets a
 * separate observability concern surface the miscalibration. A day with no prior reservation (row
 * absent) is a silent no-op, not an error -- reconciliation without a matching reservation should
 * not happen in correct usage, but must never crash a caller reporting real results back.
 *
 * The clamp is NOT associative under concurrent reconciliations of the same day -- see this
 * module's own header comment for the worked counter-example and the accepted-risk reasoning. The
 * one invariant this function actually guarantees under any interleaving is: it never throws over
 * an already-completed external call, and the recorded total never leaves `[0, cap]`.
 */
export async function reconcileGmailAiNeurons(
  db: D1Database,
  opts: ReconcileGmailAiNeuronsOptions,
): Promise<void> {
  const cap = opts.cap ?? GMAIL_AI_NEURON_DAILY_CEILING;
  if (!Number.isInteger(cap) || cap < 1 || cap > GMAIL_AI_NEURON_DAILY_CEILING) {
    throw new RangeError(
      `Gmail AI Neuron daily cap must be an integer in [1, ${GMAIL_AI_NEURON_DAILY_CEILING}], got ${cap}`,
    );
  }
  if (!Number.isInteger(opts.estimatedNeurons) || opts.estimatedNeurons < 0) {
    throw new RangeError(
      `estimatedNeurons must be a non-negative integer, got ${opts.estimatedNeurons}`,
    );
  }
  if (!Number.isInteger(opts.actualNeurons) || opts.actualNeurons < 0) {
    throw new RangeError(`actualNeurons must be a non-negative integer, got ${opts.actualNeurons}`);
  }
  const delta = opts.actualNeurons - opts.estimatedNeurons;
  await db
    .prepare(
      `UPDATE gmail_ai_neuron_budget
       SET neurons_reserved = MAX(0, MIN(?, neurons_reserved + ?))
       WHERE day = ?`,
    )
    .bind(cap, delta, opts.day)
    .run();
}
