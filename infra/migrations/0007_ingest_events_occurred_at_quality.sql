-- Migration 0007: G3 checkpoint 5, GPT-PM round-2 MAJOR, ruling option (b) (2026-09-13). Adds
-- `NormalizedEvent.occurred_at_quality` (packages/contracts/src/event.ts) to `ingest_events` so
-- the provenance distinction it carries survives persistence -- GPT-PM's own words: "silently
-- defaulting a new field and then dropping it during persistence would not close the finding."
--
-- 'PROVIDER_REPORTED' (default): `occurred_at` is genuinely the source's own reported time, the
-- semantics every existing row/producer already has. 'ESTIMATED_FROM_RECEIPT': the connector had
-- no per-signal provider timestamp and used its own processing time instead (Gmail
-- MESSAGE_DELETED/MESSAGE_UPDATED, see packages/domain/src/gmail/history-sync.ts).
--
-- This is a G2-scope table (ADR-006), not Gmail-specific -- applied to both `loadG2Schema()` and
-- `loadG3Schema()` in packages/testkit/src/schema.ts.
ALTER TABLE ingest_events ADD COLUMN occurred_at_quality TEXT NOT NULL
  DEFAULT 'PROVIDER_REPORTED'
  CHECK (occurred_at_quality IN ('PROVIDER_REPORTED', 'ESTIMATED_FROM_RECEIPT'));
