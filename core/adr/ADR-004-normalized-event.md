# ADR-004: Normalized Event Contract

**Status:** ADOPTED at G2 planning, 2026-09-12. **Source:** `docs/architecture/TDD.md` §13, §7
(provenance wrapper for `routing_hints`, MIN-1 from the v0.2 review); implementation:
`packages/contracts/src/event.ts`.

## Context

Every connector (Gmail, Telegram, future sources) must produce one shared envelope shape before an
event reaches D1, the queue, or any processing code. Without a single normalized contract, each
connector's own raw fields (subject lines, message bodies, sender display names) would leak into
shared code paths by construction, and a per-connector ad hoc shape would make INV-12 ("raw message
bodies never enter application logs, metrics, audit, queue payloads or CI fixtures") unenforceable
at the type level — it would depend on every future connector author remembering the rule.

## Decision

One connector-neutral `NormalizedEvent` schema, `.strict()` (an added `body`/`text`/`snippet` field
is a parse failure, not a silent pass-through):

```
event_id            uuid, generated at ingest
source              'telegram' | 'gmail' (SOURCES, extensible per future connector)
source_account_id   string
source_event_id     string
source_thread_id    string | null
event_type          'MESSAGE_CREATED' | 'MESSAGE_UPDATED' | 'MESSAGE_DELETED'
direction           'INBOUND' | 'OUTBOUND'
occurred_at         ISO datetime, provider-reported (source provenance, TDD §13)
received_at         ISO datetime, central transport bookkeeping (provenance-bearing the moment it
                    derives business meaning such as urgency — TDD §13, MIN-6)
content_locator     { kind: 'SOURCE_REF', ref: string } — a POINTER to content, never the content
routing_hints       ProvenanceValue[] — content-derived hints, each individually provenance-tagged
source_policy_id    string
trace_id            string
schema_version      literal 3 (SCHEMA_VERSION)
```

**Telegram routing hints can never carry an `ai_policy: ALLOW`** — enforced by a `superRefine` at
the schema boundary, not left to downstream code (INV-03/INV-04: every value derived from Telegram
content inherits Telegram provenance, and Telegram provenance is `AI_DENY` without exception in
MVP1). This is a boundary guard, not the AI boundary itself — the real enforcement is ADR-005's
type-level restriction of the AI entry point plus the runtime provenance walk. Defence in depth:
this check's existence does not excuse weakening that one.

**Idempotency key**: `(source_account_id, source_event_id, event_type)`, length-prefixed
(`${part.length}:${part}` joined with no separator) rather than delimiter-joined — a single-char
separator collides whenever a field can contain it (`("a b", "c")` and `("a", "b c")` both render
as `"a b c"` if joined with a space), and provider ids are opaque strings with no assumed alphabet.
Never derived from `received_at`, `trace_id`, or `event_id` — all three differ across retries of
the same source event, which would break the "duplicate submission returns the same logical event"
guarantee (TDD §14).

## Consequences

- A connector bug that tries to attach raw content to the shared envelope fails to parse, loudly,
  at the boundary — not three layers downstream where the reviewer has no way to tell where a leaked
  field came from.
- `routing_hints` entries are individually provenance-tagged (`ProvenanceValue`, ADR-005), so a
  Telegram-sourced hint is inspectable and rejectable independent of the event's own `source` field
  — closing the "combined event, mixed-provenance hint" gap the v0.2 review's MIN-1 raised.
- D1's `ingest_events` table (ADR-006) stores this schema's fields directly; no additional
  normalization layer sits between the connector boundary and durable storage.

## Verification owed at gate time (G2)

`packages/contracts/tests/event.test.ts` already covers: `.strict()` rejects an extra field: the
Telegram/`ai_policy: ALLOW` refinement fires only for `source === 'telegram'`, not universally; the
idempotency key's length-prefix scheme does not collide across field boundaries. Owed at G2 gate
close: an end-to-end test that a `NormalizedEvent` accepted at `POST /ingest` produces exactly one
`ingest_events` row and one `processing_outbox` row in the same D1 transaction (TDD §14), and that
resubmitting the same idempotency key returns success without a second row.
