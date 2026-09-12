# ADR-006: Durable Ingest / Outbox

**Status:** ADOPTED at G2 planning, 2026-09-12. **Source:** `docs/architecture/TDD.md` §14
(durable ingest contract), §17 (outbox/retry/reconciliation states), NM4's poison-loop closure
(reconciler excludes terminal `FAILED`/`DLQ`, `MAX_PROCESSING_ATTEMPTS=5`).

## Context

Cloudflare Queue's Free-tier retention is finite — a queue write does not by itself prove eventual
processing (TDD §17). If D1 acceptance and queue dispatch happened as two separate, non-atomic
steps, a crash between them would either lose an accepted event's processing entirely (accepted in
D1, never queued) or double-process it (queued twice from a retried connector submission). Either
failure mode violates INV-08 (processing is idempotent) and INV-09 (queue is transport, never
source of truth).

## Decision

**Ingest is atomic and D1-first** (TDD §14):

```
Source/Connector -> POST /ingest -> authenticate + validate + dedupe key ->
D1 transaction { ingest_event = ACCEPTED, outbox = PENDING } -> ACK source
```

The event is "accepted" only once this transaction commits. Duplicate submissions (same
idempotency key, ADR-004) return success without creating a second logical event or a second
outbox row.

**Two independent state machines**, never conflated:

`ingest_events.state`: `ACCEPTED -> PROCESSING -> PROCESSED`, or `-> RETRYABLE_FAILED -> DLQ`.

`processing_outbox.state`: `PENDING -> DISPATCHED`, or `-> RETRY_PENDING`, or `-> BUDGET_DEFERRED`
(soft-budget guard, TDD §16.3 — **not a failure state**; queue dispatch is paused, the event stays
durably accepted, processing resumes after the budget window resets).

**The Processing Reconciler** is the actual durability guarantee, not the queue. A scheduled job
queries exactly:

```sql
state IN ('ACCEPTED', 'RETRYABLE_FAILED')
  AND next_attempt_at <= now
  AND attempt_count < MAX_PROCESSING_ATTEMPTS  -- default 5
```

and re-dispatches. This excludes `PROCESSED` and `DLQ` by construction — a terminal state can never
re-enter the reconciler's query, satisfying INV-29 even if a queue message with a stale pointer
somehow still exists. On reaching `MAX_PROCESSING_ATTEMPTS`, a single atomic transition to `DLQ`
occurs; no automatic re-enqueue follows, even if the outbox row still says `DISPATCHED` from a
message that never actually arrived at the consumer.

**Dead-letter records are structured and content-free** (TDD §18): `event_id`, `error_class`,
`error_code`, `processor_version`, `attempt_count`, `first_failed_at`, `last_failed_at`, `trace_id`
— never the source content itself. `DLQ count > 0` is an OPS-visible signal, not silent storage.

## Consequences

- The queue payload (ADR from `packages/contracts/src/queue.ts`) carries only `{event_id,
operation, schema_version}` — the consumer always re-reads the authoritative event and outbox row
  from D1 by `event_id` rather than trusting anything the queue message itself asserts about state.
  A stale or replayed queue message can therefore never carry stale application state, only a
  pointer that gets re-validated fresh on every delivery.
- A simulated >24h queue outage (message expiry under Free retention) must be recoverable purely by
  the reconciler's D1 query, with no queue-side signal required, and must not create a duplicate
  logical event or a duplicate outbox dispatch.
- A poison event (one that always throws during processing) must reach `DLQ` in at most
  `MAX_PROCESSING_ATTEMPTS` attempts and never loop indefinitely — the reconciler's own exclusion of
  `DLQ` from its query is what terminates the loop, not a retry-count check inside the consumer.
- `BUDGET_DEFERRED` must never be reported to OPS as a failure or degrade any accepted-event
  guarantee — it is explicitly a throttling state, and the reconciler resumes dispatch once the
  daily queue-operation budget window rolls over.

## Verification owed at gate time (G2, TDD §71)

Each an independent test, not one umbrella test: accepted event persists before ACK; outbox
dispatch works; consumer is idempotent; a simulated >24h queue expiry is recovered by the
reconciler with no logical duplicate; `FAILED`/`DLQ` terminal states are excluded from the
reconciler's own query (not just "the consumer refuses to re-process them"); a poison event reaches
`DLQ` in ≤`MAX_PROCESSING_ATTEMPTS` and the reconciler never re-enqueues it afterward; queue
soft-budget degradation (`BUDGET_DEFERRED`) preserves the accepted event and resumes on the next
quota window; DLQ is visible and actionable (an oldest-accepted-unprocessed metric exists).
