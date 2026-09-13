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

## Addendum: implemented protocol (G2 gate review remediation, 2026-09-13)

This is an addition documenting what the implementation actually settled on where the original
decision above under-specified a mechanism GPT-PM's gate review found load-bearing. Nothing above
is superseded.

**`processing_outbox.state` gains a fifth, genuinely terminal value: `CLOSED`.** The Decision
section above lists `PENDING -> DISPATCHED -> RETRY_PENDING -> BUDGET_DEFERRED` but does not name
how a successfully processed event's outbox row is retired. `completeProcessing` transitions it to
`CLOSED` in the same batch that marks `ingest_events.state = PROCESSED` — the reconciler's own
candidate query (`o.state <> 'CLOSED'`) excludes it by construction, the same "terminal state can
never re-enter the query" property already claimed above for `ingest_events`, extended to the
outbox's own state machine.

**Two independently-incrementing counters, not one.** `ingest_events.processing_attempt_count`
tracks how many times a processing LEASE was actually claimed (advanced by `claimLease`);
`processing_outbox.dispatch_count` tracks how many times the reconciler has DISPATCHED this event
to the Queue (advanced by `reconcileDispatch`). These are deliberately separate: a dispatch that
the Queue never delivers, or that the consumer's Worker crashes before claiming, increments
`dispatch_count` without ever incrementing `processing_attempt_count`. Conflating them would let a
purely transport-level redelivery consume the same attempt budget as an actual processing failure.

**Redispatch protocol.** Every successful dispatch (`reconcileDispatch`) sets
`processing_outbox.next_attempt_at = now + REDISPATCH_TIMEOUT_MS`, not just at claim time. A
DISPATCHED-but-still-DISPATCHED row past that deadline is treated as a lost dispatch (Queue never
delivered it, or the consumer never claimed it) and becomes eligible for a fresh dispatch, fenced by
a CAS on the OBSERVED `dispatch_count` value at read time:
`(state IN (eligible) OR (state = 'DISPATCHED' AND dispatch_count = <observed>))`. This is what
makes the ">24h Cloudflare Queue retention expiry" scenario in the Verification section above
concretely recoverable: the reconciler's own D1-driven redispatch, not any Queue-side signal, is
what re-enqueues a message the Queue silently dropped. `REDISPATCH_TIMEOUT_MS` is a runtime var
(`infra/cloudflare/ingest.wrangler.toml`), independent of the Queue's own retention window.

**Claim requires a live, reconciler-authorized dispatch.** `claimLease` requires
`processing_outbox.state = 'DISPATCHED'` in addition to `ingest_events.state IN ('ACCEPTED',
'RETRYABLE_FAILED')` and `processing_attempt_count < maxAttempts` — closing a gap where a
delayed/duplicate Queue redelivery (Cloudflare Queues' at-least-once semantics) of a message for an
event now sitting in its `RETRY_PENDING` backoff window could otherwise claim an attempt the
reconciler never actually authorized for that point in time, burning through the attempt budget
with no corresponding budgeted dispatch behind any of it.

**Fresh-token heartbeat, wired into the live processing path.** `claimLease` issues a fresh,
never-reused lease token per claim (the ABA-race guard `recoverStaleLeases`'s fencing already
depended on). `processMessage` now actively renews that lease on a fixed interval
(`renewLease`, defaulting to half the lease duration) for the entire duration `process()` runs,
using a FRESH clock reading on every tick — a processing attempt that genuinely takes longer than
the fixed lease TTL (real I/O latency, not a hang) is no longer wrongly reclaimed by
`recoverStaleLeases` out from under still-active work. A `ClaimedEvent.leaseLost: AbortSignal`
fires the moment a renewal reports the fence already lost (a sweep reclaimed it first), so a
cooperative processor can abandon further external work — the D1 layer stays safe regardless,
since `completeProcessing`/`failProcessing` are token-fenced and a stale completion after the fence
is lost simply reports `transitioned: false`.

**Adopted Queue wire contract.** `packages/contracts/src/queue.ts`'s `QueuePayloadSchema`
(`{event_id: uuid, operation: 'PROCESS_EVENT', schema_version}`) — defined at an earlier gate but
never adopted — is now the actual message both sides use: `services/ingest`'s scheduled handler
constructs it when sending, and `services/processor`'s consumer runs `QueuePayloadSchema.safeParse`
against every inbound message body before trusting any field, `ack()`-and-skipping a message that
fails the contract (D1 remains the source of truth for what still needs processing, so a
Queue-level retry of a message that never matched the contract could accomplish nothing).

**A throwing `Queue.send()` never aborts the rest of a scheduled tick.** Each dispatched event's
own D1 transition already committed independently before any send is attempted; the scheduled
handler wraps each `send()` in its own try/catch and reports failures in a `sendFailures` array
rather than propagating, so one Queue outage partway through a batch does not strand every event
after the failing one — they simply wait for the next tick's redispatch-due window, identical to a
message the Queue silently dropped in transit.
