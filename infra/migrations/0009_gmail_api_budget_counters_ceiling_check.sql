-- Migration 0009: G3 checkpoint 6, internal review finding (2026-09-13, functional-test-reviewer +
-- database-reviewer, independently).
--
-- gmail_api_budget_counters (migration 0002) was created with only a lower-bound CHECK
-- (units_consumed >= 0), unlike its two sibling quota tables from the same migration:
-- gmail_rate_reservations has CHECK (units_reserved >= 0 AND units_reserved <= 6000), and
-- gmail_ai_neuron_budget has CHECK (neurons_reserved >= 0 AND neurons_reserved <= 10000). For this
-- one resource, the 80,000,000-units/day project-wide ceiling (EXTERNAL_ASSUMPTIONS.md SS D) was
-- enforced ONLY by reserveGmailApiUnits's own application-level WHERE clause
-- (packages/domain/src/gmail/quota.ts), with no defense-in-depth backstop the way the other two
-- resources already have: any future direct-SQL write to this table (bypassing the reservation
-- function) or a regression in the WHERE clause's own comparison would have no DB-level guard to
-- catch it before silently exceeding the real Gmail API daily project ceiling.
--
-- SQLite/D1 cannot add a CHECK constraint to an existing table via ALTER TABLE -- this migration
-- rebuilds the table, per this project's established convention (migration 0008). Migration 0002's
-- own file is left untouched, per the append-only migration convention; this is a new migration,
-- not an edit of a committed one. Nothing has been deployed against this table's shape outside this
-- repo's own test fixtures (checkpoint 6 has not shipped a real caller yet), so the rebuild is a
-- plain DROP + CREATE, not a copy-preserving migration.
DROP TABLE gmail_api_budget_counters;
CREATE TABLE gmail_api_budget_counters (
  day TEXT PRIMARY KEY,
  units_consumed INTEGER NOT NULL DEFAULT 0
    CHECK (units_consumed >= 0 AND units_consumed <= 80000000)
);
