-- Migration 0010: G3 checkpoint 6, GPT-PM round 1 (2026-09-13, VERDICT: MAJOR, 0 BLOCKER / 5 MAJOR).
--
-- Two of round 1's five MAJOR findings, ruled by GPT-PM to require "one coherent
-- reservation-ledger/raw-accounting design rather than adding more clamps around the current
-- aggregate":
--
-- Finding #1: reconcileGmailAiNeurons had no durable per-call identity, so a retried reconciliation
-- (an ordinary Worker/message retry, or an operator re-invoking it) applied its delta AGAIN,
-- silently corrupting the day's tracked total on every duplicate call.
--
-- Finding #2: the old per-call clamp (MAX(0, MIN(cap, neurons_reserved + delta))) was not
-- associative -- the FINAL recorded total after several reconciliations depended on the order D1
-- happened to serialize them in, even when no individual delta itself needed clamping. GPT-PM's own
-- worked counter-example (day total 200, two reconciliations with deltas +9850 and -100 against a
-- 10000 cap): applying them in one order ends at 9900, the other order ends at 9950 -- identical
-- logical operations, two different final ledgers.
--
-- Fix: gmail_ai_neuron_reservations is a new per-RESERVATION ledger (one row per
-- reserveGmailAiNeurons call, keyed by a caller-opaque reservation_id). The aggregate is maintained
-- by triggers, so reservation plus aggregate increment is one INSERT statement and reconciliation
-- plus aggregate adjustment is one fenced UPDATE statement. A repeat reconciliation affects zero
-- rows and therefore fires no trigger (closes finding #1). Because each reservation's own
-- contribution to the aggregate (its pending estimated_neurons, or its final actual_neurons once
-- reconciled) is now counted EXACTLY ONCE by construction, the aggregate column no longer needs a
-- per-call clamp at all -- plain addition is associative/commutative, so the final total no longer
-- depends on reconciliation arrival order (closes finding #2). See packages/domain/src/gmail/
-- quota.ts's own module header for the full reasoning.
--
-- gmail_ai_neuron_budget's own upper-bound CHECK (<= 10000) is removed: the aggregate is now a RAW,
-- never-clamped running total, and a genuine gross under-estimate can legitimately push it above
-- 10000 after the fact (visible, not hidden by a silent clamp) -- the cap is enforced ONLY at
-- reservation time (reserveGmailAiNeurons's own WHERE-gated ledger INSERT), never re-applied
-- during reconciliation. The lower bound (>= 0) is retained for defense-in-depth even though it is
-- now also a structural invariant (every value ever added is non-negative and applied exactly once).
--
-- SQLite/D1 cannot drop a CHECK constraint via ALTER TABLE -- this migration rebuilds the table, per
-- this project's established convention (migrations 0008, 0009). Migration 0002's own file is left
-- untouched, per the append-only migration convention. Nothing has been deployed against this
-- table's shape outside this repo's own test fixtures (checkpoint 6 has not shipped a real caller
-- yet), so the rebuild is a plain DROP + CREATE, not a copy-preserving migration.
DROP TABLE gmail_ai_neuron_budget;
CREATE TABLE gmail_ai_neuron_budget (
  day TEXT PRIMARY KEY,
  neurons_reserved INTEGER NOT NULL DEFAULT 0 CHECK (neurons_reserved >= 0)
);

CREATE TABLE gmail_ai_neuron_reservations (
  reservation_id TEXT PRIMARY KEY,
  day TEXT NOT NULL REFERENCES gmail_ai_neuron_budget (day),
  estimated_neurons INTEGER NOT NULL CHECK (estimated_neurons >= 0),
  reconciled INTEGER NOT NULL DEFAULT 0 CHECK (reconciled IN (0, 1)),
  -- NULL until reconciled; NOT NULL exactly when reconciled = 1 (enforced by the CHECK below).
  actual_neurons INTEGER,
  created_at TEXT NOT NULL,
  reconciled_at TEXT,
  CHECK ((reconciled = 1) = (actual_neurons IS NOT NULL AND reconciled_at IS NOT NULL))
);
-- reconcileGmailAiNeurons looks up a reservation by its own PK (reservation_id), so this index
-- supports the query pattern that actually exists today: nothing currently queries this table by
-- `day` alone. Added anyway, matching gmail_history_sync_progress-style forward-looking indexing
-- for the day-scoped observability/reporting queries this ledger's own existence is meant to enable
-- once a real caller exists.
CREATE INDEX idx_gmail_ai_neuron_reservations_day ON gmail_ai_neuron_reservations (day);

-- A reservation INSERT is the atomic boundary. The BEFORE trigger creates the parent day row when
-- needed; the AFTER trigger adds the estimate in the same SQLite statement/transaction. The
-- application INSERT itself is cap-gated against the current raw aggregate, so a refused
-- reservation creates neither a ledger row nor aggregate usage.
CREATE TRIGGER trg_gmail_ai_neuron_reservation_ensure_day
BEFORE INSERT ON gmail_ai_neuron_reservations
BEGIN
  INSERT INTO gmail_ai_neuron_budget (day, neurons_reserved)
  VALUES (NEW.day, 0)
  ON CONFLICT (day) DO NOTHING;
END;

CREATE TRIGGER trg_gmail_ai_neuron_reservation_add_estimate
AFTER INSERT ON gmail_ai_neuron_reservations
BEGIN
  UPDATE gmail_ai_neuron_budget
  SET neurons_reserved = neurons_reserved + NEW.estimated_neurons
  WHERE day = NEW.day;
END;

-- The application UPDATE is fenced by `reconciled = 0`. Therefore this trigger runs exactly once
-- per reservation and plain addition remains associative/commutative across concurrent callers.
CREATE TRIGGER trg_gmail_ai_neuron_reservation_reconcile
AFTER UPDATE OF reconciled ON gmail_ai_neuron_reservations
WHEN OLD.reconciled = 0 AND NEW.reconciled = 1
BEGIN
  UPDATE gmail_ai_neuron_budget
  SET neurons_reserved = neurons_reserved + NEW.actual_neurons - OLD.estimated_neurons
  WHERE day = NEW.day;
END;
