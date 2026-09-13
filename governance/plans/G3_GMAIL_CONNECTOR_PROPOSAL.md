# G3 Gmail Connector — Architecture Proposal V6

**Author:** Claude (implementer). **Status:** DRAFT V6, remediating GPT-PM round 5 (`VERDICT:
MAJOR`, 0 BLOCKER + 3 MAJOR on V5 — V5's fixes were directionally correct but each left one
specific gap round 5 found). **Source:**
`docs/architecture/TDD.md` §7.1, §12, §12.1, §12.2, §13, §14, §24, §24.1, §24.2, §25, §33.1, §35,
§39, §62, §65, §69, §70, §79-81, §85 (R3); `docs/architecture/EXTERNAL_ASSUMPTIONS.md` §D;
`core/RISK_REGISTER.md` R3; `core/adr/ADR-002-gmail-telegram-mvp1.md`,
`ADR-006-durable-ingest-outbox.md`, `ADR-009-workers-ai-gmail-only.md`;
`infra/migrations/0001_ingest_outbox.sql`; `services/ingest/src/handler.ts`;
`services/ingest/src/env.ts`; `packages/domain/src/ingest.ts`; `packages/contracts/src/event.ts`;
`services/processor/src/processor.ts`; `services/processor/src/handler.ts`;
`packages/domain/src/lease.ts`; `packages/domain/src/lease-recovery.ts`;
`packages/domain/src/budget.ts`; `packages/domain/src/transitions.ts`;
`core/adr/ADR-010-hard-zero-cost.md`; `docs/architecture/EXTERNAL_ASSUMPTIONS.md` §C ("Workers AI
free allocation is 10,000 Neurons/day"); Gmail API reference `users.history.list` (fetched live
round 2 — see §2.2); Google Cloud Pub/Sub push-delivery reference (round 3: 2xx acknowledges,
non-2xx/expired-deadline redelivers with the SAME `messageId`, no exactly-once guarantee);
Cloudflare Workers isolate model (round 3: requests are not guaranteed to reach the same instance,
isolate memory is not shared across instances).

**What changed from V5, and why (GPT-PM round 5 findings, verified against source before
remediating, per §3/§23 — all 3 confirmed real, none disputed):**

1. MAJOR — the reclaim UPDATE fenced on token and expiry but not on `state='IN_PROGRESS'` itself,
   leaving a SELECT→completion→reclaim race. Verified directly against
   `packages/domain/src/transitions.ts`: EVERY G2 lease mutation's WHERE clause is
   `event_id = ? AND state = 'PROCESSING' AND ${fenceSql}` (lines 90, 177, 210) — state is always
   part of the fence, never just token+expiry, and migration 0001's own comment on `ingest_events`
   says so explicitly ("the SOLE compare-and-swap fencing value for every mutation of a PROCESSING
   row"... "additionally conditions on processing_lease_expires_at at mutation time"). §2.6 below
   fixes this by adding `state = 'IN_PROGRESS'` to the reclaim's WHERE clause.
2. MAJOR — the proposed `idx_gmail_push_deliveries_lease` was a full index, not the partial index
   G2 actually uses. Verified directly against `infra/migrations/0001_ingest_outbox.sql:159-161`:
   `idx_ingest_events_processing_lease` carries `WHERE state = 'PROCESSING'` — a partial index that
   excludes terminal rows from the scan entirely, which is the actual point (retained `COMPLETED`
   rows would otherwise dominate the expiry-ordered range before the `LIMIT` finds the few active
   ones). §2.6 below fixes the index definition and strengthens the test to prove coverage, not just
   that the index is named.
3. MAJOR — the new AI budget correctly separated the resource and the `maxAttempts` multiplier but
   still measured raw invocation count, not the platform's real ceiling. Verified directly against
   `docs/architecture/EXTERNAL_ASSUMPTIONS.md` §C: "Workers AI free allocation is 10,000 Neurons/day"
   is the actual documented HARD_ZERO unit — two invocations can consume very different Neuron
   amounts depending on model/input/output size, so an invocation counter can read "within limit"
   while the real Neuron allocation is already exhausted. §2.9 below switches the reservation to a
   conservative per-call Neuron estimate.

Unchanged from V5 (round 5 found no issue): the two-part token+expiry reclaim fence's basic shape,
the explicit sweep batch bound, and the `maxAttempts`-based worst-case multiplier itself (only the
unit being multiplied was wrong).

**What changed from V4, and why (GPT-PM round 4 findings, verified against source before
remediating, per §3/§23 — all 3 confirmed real, none disputed):**

1. MAJOR — the reclaim UPDATE for `gmail_push_deliveries` fenced only on the observed
   `lease_token`, not a fresh `lease_expires_at` re-check at mutation time — the exact heartbeat
   race G2's own `recoverStaleLeases` already solved. Verified directly against
   `packages/domain/src/lease.ts` (`renewLease`'s own doc comment: "Renews a held lease's expiry
   WITHOUT rotating its token... the exact property the stale-lease-recovery sweep's
   `requireExpiredAsOf` guard exists to be safe against") and `packages/domain/src/lease-recovery.ts`
   (`recoverStaleLeases`'s `LeaseFence` fences on `{ token, requireExpiredAsOf: opts.now }` — token
   AND a fresh expiry check, together, at the mutation itself, not just at the earlier SELECT).
   §2.6 below fixes this by requiring the identical two-part fence.
2. MAJOR — the new recovery sweep had no batch bound and no supporting index, an unbounded
   growing-table scan in a Free-plan-D1 hot path. Verified directly against
   `packages/domain/src/lease-recovery.ts` (`recoverStaleLeases`'s own query: `ORDER BY
processing_lease_expires_at LIMIT ?`) and `infra/migrations/0001_ingest_outbox.sql:159-160`
   (`idx_ingest_events_processing_lease ON ingest_events(processing_lease_expires_at, event_id,
processing_attempt_count)`, the exact index G2's own sweep query relies on). §2.6 below adds the
   matching index and batch bound to `gmail_push_deliveries`.
3. MAJOR — the crash-ambiguity quota accounting budgeted exactly one extra AI invocation, but G2's
   processor allows up to `maxAttempts` attempts per event (`packages/domain/src/lease.ts`'s own
   `processing_attempt_count < maxAttempts` backstop), so the same event can accumulate multiple
   successful-but-unrecorded AI calls before terminal failure — and the budget was charged against
   Gmail API units, not the separate Workers AI `HARD_ZERO` ceiling (`core/adr/ADR-010-hard-zero-
cost.md`; ADR-009 requires its own AI-quota-exhausted test). §2.9 below fixes both: worst-case
   accounting now covers the full configured attempt cap, charged against the correct AI-quota
   resource, separate from the Gmail-unit reservation.

Unchanged from V4 (round 4 found no issue): the lease-token pass-through into `ClaimedEvent`, the
fenced enrichment INSERT, `leaseLost` cooperation, the revised "one canonical persisted result"
enrichment guarantee, the non-2xx response for a live in-flight duplicate, and the D1 shared atomic
Gmail rate reservation itself (the cross-isolate limiter finding is fully closed).

**What changed from V3, and why (GPT-PM round 3 findings, verified against source before
remediating, per §3/§23 — all 5 confirmed real, none disputed):**

1. BLOCKER — Gmail enrichment writes are outside G2's processing-lease fence. Verified directly:
   `services/processor/src/processor.ts`'s `ClaimedEvent` interface carries only `eventId`,
   `attemptNumber`, and `leaseLost` — no lease token. `services/processor/src/handler.ts:134-162`
   confirms the token exists at that call site (`claim.token`, used at lines 149/176/187 for the
   heartbeat and G2's own `completeProcessing`/`failProcessing` calls) but is never included in the
   object passed to `process()`. So no `EventProcessor` implementation, including a future
   `GmailEventProcessor`, has any way to fence a durable write against the current lease — the
   contract gap is real and structural, not a G3 document oversight. §2.4 below fixes this by
   extending G2's own `ClaimedEvent`/`handler.ts` (additive, small, backward-compatible) to carry
   `leaseToken`, and fencing the new enrichment write with it exactly like `lease.ts`'s own
   `WHERE event_id = ? AND state = 'PROCESSING' AND processing_lease_token = ?` pattern.
2. BLOCKER — ACKing an unexpired `IN_PROGRESS` duplicate can permanently lose Pub/Sub's only
   recovery delivery if the original crashes after that ACK. Confirmed against Pub/Sub's own
   documented push semantics (2xx acknowledges; a message is redelivered only on non-2xx or expired
   ack deadline, with the same `messageId`) — V3's design ACKs the in-flight duplicate with no
   independent recovery path if the original attempt then dies. §2.6 below fixes this: no delivery
   is ACKed until COMPLETED or genuinely reclaimed, and a scheduled sweep (independent of Pub/Sub
   redelivery) recovers a stuck `IN_PROGRESS` row.
3. MAJOR — `gmail_push_deliveries` was called a "lease" but had no fence token, CAS reclaim, or
   heartbeat — just a bare state column. §2.6 below fixes this with a real per-claim UUID token,
   CAS-based reclaim that rotates the token, and heartbeat renewal, mirroring `lease.ts`'s actual
   design rather than just its name.
4. MAJOR — "AI runs at most once per event, ever" is not a guarantee the step-0 row check can
   provide: a crash between a successful AI call and the enrichment INSERT is indistinguishable
   from "AI never ran," so a retry calls AI again. §2.4 below revises the claim to what the design
   actually guarantees (one canonical persisted enrichment; AI invocation potentially at-least-once
   around that specific crash window) and accounts for a duplicate AI call in quota math.
5. MAJOR — an in-memory token bucket cannot enforce a shared per-account quota across Cloudflare
   Worker isolates, which do not share memory and are not guaranteed request affinity. §2.9 below
   replaces it with a D1-based shared atomic reservation, mirroring `packages/domain/src/budget.ts`'s
   `INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING` pattern.

Unchanged from V3 (round 3 found no issue): §2.1 ingress identity, §2.2 cursor, §2.3 history
matrix, §2.5 OAuth, §2.7 KEK, §2.8 drill-down.

**What changed from V2, and why (GPT-PM round 2 findings, verified against source/live docs before
remediating, per §3/§23 — all 7 confirmed real, none disputed):**

1. BLOCKER — the proposed `gmail-connector-internal` connector identity is incompatible with the
   existing, unchanged `/ingest/gmail` handler. Verified: `services/ingest/src/handler.ts:121`
   derives `connectorId` literally from the URL path (`INGEST_PATH_RE` capture group), so
   `/ingest/gmail` means `connectorId === 'gmail'`, full stop — and line 199 rejects any event
   whose `source` doesn't match. `services/ingest/src/env.ts:14` already declares a
   `GMAIL_V1_HMAC_SECRET?: string` binding (G2 anticipated this connector by name). §2.1 below
   fixes this — no redesign needed, just the correct identity.
2. BLOCKER — the per-page cursor-advance protocol can skip an entire page of Gmail changes on a
   crash. Verified live against Google's own Gmail API reference for `users.history.list`
   (fetched this round): the `historyId` response field's exact documented guidance is _"If you
   receive no `nextPageToken` in the response, there are no updates to retrieve and you can store
   the returned `historyId` for a future request"_ — meaning `historyId` is safe to persist ONLY
   from the final page of a paginated traversal, never from an intermediate page, which is exactly
   what V2's protocol did. §2.2 below fixes this.
3. BLOCKER — the normalization matrix invented `event_type` values that don't exist, and its
   label-change identity collides. Verified: `packages/contracts/src/event.ts:40` defines
   `EVENT_TYPES = ['MESSAGE_CREATED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED']` — V2's
   `MESSAGE_RECEIVED`/`MESSAGE_LABEL_CHANGED` values would fail `NormalizedEventSchema.parse()`
   outright. §2.3 below fixes the mapping and the collision.
4. MAJOR — the AI processor has no lifecycle for `MESSAGE_DELETED` events (it would try to fetch
   content that no longer exists) and no idempotent-persistence story for a crash between
   enrichment-write and pipeline-completion. §2.4 below fixes both.
5. MAJOR — the Pub/Sub replay-suppression design copied a permanent-reject nonce pattern onto
   at-least-once push delivery, which can suppress the exact redelivery needed to recover from a
   mid-processing crash. §2.6 below redesigns it as a lease/fence, mirroring G2's own
   `claimLease`/stale-recovery pattern instead of inventing new semantics.
6. MAJOR — the drill-down endpoint referenced "the stored access token," but this design only ever
   stores a refresh token. §2.8 below states the actual exchange-on-demand path.
7. MAJOR — the quota design covered the 80M/day ceiling but not the 6,000/unit/min-per-user
   ceiling; a burst of gap-recovery `messages.get` calls could 429 well before the daily budget
   looks unhealthy. §2.9 below adds a short-window limiter.

Unchanged from V2 (GPT-PM found no scoped issue): §2.5 OAuth lifecycle, §2.7 KEK design.

## 1. Scope (unchanged from V1)

Gmail connector: OAuth (Authorization Code + PKCE), `users.watch` + Pub/Sub push as the primary
mode with an explicit `GMAIL_COLLECTION_MODE=POLL` fallback, daily watch renewal, bounded gap
recovery via `history.list`, encrypted refresh-token storage, a `GmailEvidenceBundle` +
source-local AI extraction pipeline, and authenticated message/thread drill-down. Feeds G2's
existing durable pipeline as an authenticated CLIENT of it (not a second trusted writer — see
§2.1), producing `NormalizedEvent`s exactly like the Telegram connector does.

**Explicitly out of scope for G3** (per ADR-002, ADR-009): cross-channel topic resolution, any
non-Gmail source, AI over combined/Topic-level content, sending mail, any scope beyond
`gmail.readonly`.

## 2. Design, remediated

### 2.1 Ingress boundary: reuse `/ingest/gmail`, don't call `ingestEvent()` directly

`services/gmail-connector/` does **not** import `@pdos/domain`'s `ingestEvent` at all. After
normalizing a raw Gmail message/history record into a `NormalizedEvent`, it sends it to the
**already-hardened, already-reviewed** `POST /ingest/gmail` endpoint on `services/ingest`, using
the exact same connector-key/HMAC/timestamp/nonce mechanism (`checkKeyAndTimestamp`/
`checkSignatureAndNonce`) any other connector uses. **Connector identity is `gmail` — the exact
value the URL path itself derives (`services/ingest/src/handler.ts:121`), not a separate
`gmail-connector-internal` identity** (V2's mistake, corrected): the HMAC secret binding is
`GMAIL_V1_HMAC_SECRET`, already declared (currently optional/unset) in
`services/ingest/src/env.ts:14` — G2 anticipated exactly this connector by name. Every submitted
`NormalizedEvent.source` is `'gmail'`, matching the `event.source !== connectorId` check at
`handler.ts:199` exactly. Call transport: a Cloudflare
[service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
from `gmail-connector` to `ingest` (in-process RPC, no public network hop, still goes through the
full `fetch()` handler and its auth chain) — not a bare function import.

This means: zero new trusted-write surface. Every Gmail event goes through the identical
authenticate → validate (`NormalizedEventSchema.parse`) → dedupe (`idempotency_key`) → D1
transaction boundary TDD §14 defines, that G2's own multiple review rounds already hardened
(body-size cap, replay-nonce table, `SOURCE_MISMATCH` check). A defect in the Gmail connector can
forge a badly-shaped or unauthenticated-looking event, but cannot skip the ingest boundary itself —
it would be rejected by the exact same checks a compromised Telegram connector would also hit.

### 2.2 Single authoritative cursor: `source_cursors`, not a duplicate `last_history_id`

`gmail_connections` (§2.5) does **not** carry `last_history_id`/`gap_state`. The ONLY authoritative
sync-position record is the existing `source_cursors.cursor_value` row, keyed by
`source_account_id`, exactly as `0001_ingest_outbox.sql`'s own comment already names it for. The
opaque `cursor_value` (a JSON string) holds `{historyId, lastSeenInternalDate}` — both fields TDD
§12 requires (`last_history_id`, `last_seen_internal_date`), stored together as one opaque unit
rather than as separate typed columns, matching this column's existing opaque-string design instead
of migrating it to a structured shape.

**Crash-safe accept-then-advance protocol, corrected for Gmail's real pagination contract**
(V2's per-page CAS was a BLOCKER: Gmail's own API reference states plainly that `historyId` is
"safe to store for a future request" only once a response carries **no** `nextPageToken` — an
intermediate page's `historyId` is not a valid resume point. Verified live against
`developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list` this round, not
assumed.). Cursor A stays authoritative across the **entire** paginated traversal, not per page:

1. Read the current `cursor_value` (cursor A: `{historyId, lastSeenInternalDate}`).
2. Call `history.list(startHistoryId=A.historyId)`. For every resulting change on this page,
   build and durably submit a `NormalizedEvent` via §2.1's ingest call — **every submission on
   this page must succeed (including idempotent no-ops) before continuing to the next page.**
3. If the response carries a `nextPageToken`: call `history.list` again with that token (same
   `startHistoryId=A.historyId`, per Gmail's own pagination contract — the token, not a new
   `historyId`, drives continuation) and repeat step 2. **Cursor A is not touched anywhere in this
   loop.**
4. Only once a response carries **no** `nextPageToken` (the final page): CAS-advance
   `source_cursors.cursor_value` from A to that final response's own `historyId` (plus the newest
   `internalDate` seen across the whole traversal)
   (`WHERE source_account_id = ? AND cursor_value = ?`, checking `meta.changes === 1`) — a CAS
   loss (an overlapping push+poll race) means re-read and reconcile rather than blindly overwrite.
5. **Crash safety, the point of this redesign:** if the process dies at ANY point before step 4
   completes — mid-page, between pages, anywhere — cursor A is still exactly what it was at step
   1. The next tick re-runs the ENTIRE traversal from A: already-accepted events from earlier
      pages become safe `ALREADY_ACCEPTED` no-ops (idempotency key), and any page/event not yet
      durably accepted is retried for real. No page can be silently skipped, because nothing is
      considered "done" until the whole multi-page traversal succeeds.
6. If Gmail returns 404/invalid cursor A: this project's own bounded-recovery decision (not
   Google's default full-resync) applies — recover only from
   `max(connected_at, last successfully advanced cursor's timestamp)` forward via
   `messages.list`/`messages.get`, per V1's already-correct attribution. This is the SAME
   accept-then-advance protocol (steps 1-5), just re-bootstrapped from a narrower starting point.

**PUSH vs. POLL bootstrap, made explicit** (V1 left this contradictory — `startWatch` was called
unconditionally from the OAuth callback even though POLL is the stated default): the OAuth callback
does **not** unconditionally call `startWatch`. It reads `GMAIL_COLLECTION_MODE` (default `POLL`
per §12.2/R3) and only calls `startWatch` when the mode is `PUSH`; a later operator-driven mode
flip (once the billing-account question resolves) calls `startWatch` at that time instead, not
retroactively at connection time.

### 2.3 Gmail history → G2 event identity matrix

**Corrected to G2's REAL 3-value `event_type` enum** (`packages/contracts/src/event.ts:40`:
`MESSAGE_CREATED | MESSAGE_UPDATED | MESSAGE_DELETED` — V2 invented two values that don't exist
and would have failed `NormalizedEventSchema.parse()` on the first real event). Every
`history.list` entry and `messages.list` bootstrap result is classified into exactly one of:

| Gmail signal                                                                               | `event_type`                                          | `source_event_id`  | `source_version`                                                                                                                       | Notes                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messagesAdded`                                                                            | `MESSAGE_CREATED`                                     | Gmail `message.id` | not required (messages are immutable, TDD/Gmail docs both confirm — see V1's own already-verified citation)                            | one event per distinct `message.id` seen, even if it appears in multiple history records (idempotency key dedupes)                                                                                                                                                                                                                              |
| `messagesDeleted`                                                                          | `MESSAGE_DELETED`                                     | same `message.id`  | not required                                                                                                                           | recorded as a distinct logical event from its own `MESSAGE_CREATED`, never mutates/removes the original row (INV: events are append-only)                                                                                                                                                                                                       |
| `labelsAdded` for a message in one history record                                          | `MESSAGE_UPDATED`                                     | `message.id`       | `` `${historyRecordId}:LABEL_ADDED` `` — the record-level id (not the account-level cursor) PLUS an explicit change-kind discriminator | ALL labels added to this message within this one history record collapse into ONE canonical `MESSAGE_UPDATED` event (the enrichment/label-set itself is refetched live from Gmail during processing, not encoded in the identity)                                                                                                               |
| `labelsRemoved` for the SAME message in the SAME history record                            | `MESSAGE_UPDATED`                                     | `message.id`       | `` `${historyRecordId}:LABEL_REMOVED` `` — same record id, DIFFERENT discriminator                                                     | **fixes the round-2 BLOCKER**: without the `LABEL_ADDED`/`LABEL_REMOVED` suffix, this would share `source_version` with the row above (same record, same message) and collide onto one idempotency key, silently dropping one of the two distinct changes. The suffix makes them provably distinct `source_version`s.                           |
| Multiple change types for one message in one history record                                | one `NormalizedEvent` per (message, change-kind) pair | —                  | —                                                                                                                                      | a `messagesAdded` + `labelsAdded` in the same record produces two events, same `message.id`, different `event_type`; a `labelsAdded` + `labelsRemoved` in the same record produces two `MESSAGE_UPDATED` events, distinguished by the discriminator above — cardinality is unconditionally "one event per (message, change-kind)," never merged |
| Out-of-order push delivery (a later history record's push arrives before an earlier one's) | handled by design, not by ordering assumption         | —                  | —                                                                                                                                      | §2.2's protocol submits by `idempotency_key`, which doesn't depend on arrival order; the cursor only ever advances forward from a fully-completed traversal, so an out-of-order push just means two overlapping traversals process overlapping data, with the CAS in §2.2 step 4 preventing either from silently winning over unprocessed data  |

Every produced event is round-tripped through the REAL `NormalizedEventSchema.parse()` (not just
asserted against this table by inspection) in
`connectors/gmail/tests/history-normalization.test.ts` — one test per row above, plus the
repeated-delivery and multi-change-per-record cases, each proving same input twice → identical
`idempotency_key` → one row, and distinct (message, change-kind) inputs → distinct
`idempotency_key`s → two rows.

### 2.4 AI extraction pipeline, wired into the actual processing lifecycle

G2's `services/processor` currently defaults to `noopProcessor` (deliberately deferred — TDD's own
comments say so). G3 supplies a real `GmailEventProcessor` and wires it in as the injected
`EventProcessor` for events whose `source === 'gmail'`.

**Event-type-aware processing, first branch (fixes the round-2 MAJOR — a `MESSAGE_DELETED` event
would otherwise try to fetch content that no longer exists and DLQ):**

- `event_type === 'MESSAGE_DELETED'`: no content fetch is attempted at all — the message is gone
  by definition. The processor writes an explicit `gmail_source_enrichments` row with
  `status = 'NO_CONTENT_DELETED'` (no AI call, no bundle) and completes immediately. This satisfies
  §3's "always a row or an explicit marker" test invariant without ever touching the Gmail API for
  content that cannot exist.
- `event_type` is `MESSAGE_CREATED` or `MESSAGE_UPDATED`: proceeds through the full pipeline below.

**Lease-fenced enrichment persistence (fixes the round-3 BLOCKER — a stale claimant must not be
able to author the canonical enrichment after losing its fence):**

Verified directly against source before designing this: `services/processor/src/processor.ts`'s
`ClaimedEvent` currently exposes only `eventId`, `attemptNumber`, `leaseLost` — no lease token —
even though `services/processor/src/handler.ts:134` has `claim.token` in scope at the exact point
it constructs the object passed to `process()` (lines 158-162) and simply never includes it. This
is a small, additive extension to G2's own processor package, not a G3-only workaround:

- **`ClaimedEvent` gains a `leaseToken: string` field.** `handler.ts`'s call to `process()` becomes
  `{ eventId: opts.eventId, attemptNumber: claim.attemptNumber, leaseToken: claim.token, leaseLost:
leaseLostController.signal }`. Purely additive — `noopProcessor` and every existing G2 test that
  constructs a `ClaimedEvent` literal keep compiling and passing unchanged; this is a regression
  test in §3, not an assumption.
- **The `gmail_source_enrichments` INSERT is fenced by that exact token**, mirroring
  `packages/domain/src/lease.ts`'s own completion/failure statements: `INSERT INTO
gmail_source_enrichments (event_id, ...) SELECT ?, ... WHERE EXISTS (SELECT 1 FROM ingest_events
WHERE event_id = ? AND state = 'PROCESSING' AND processing_lease_token = ?)` (SQLite's
  `INSERT ... SELECT ... WHERE EXISTS` — zero rows written, not an error, when the fence no longer
  matches). A zero-row result is treated as `RETRYABLE_FAILURE` with `errorClass = 'LEASE_LOST'` —
  the attempt no longer owns the event, so it must not claim success.
- **`GmailEventProcessor` cooperates with `leaseLost`**: before each externally-visible step (Gmail
  API fetch, AI call, the fenced INSERT itself) it checks `leaseLost.aborted` and abandons further
  work immediately if set, rather than completing wasted work under a fence it no longer holds.

**Revised enrichment guarantee (fixes the round-3 MAJOR — "AI runs at most once, ever" is not
provable across a crash between AI success and the INSERT committing):** the architecture
guarantees exactly one canonical **persisted** enrichment row per `event_id` (the PRIMARY KEY plus
the lease-fenced INSERT above jointly guarantee that), not that the AI provider is invoked at most
once — a crash after a successful `AIProvider` call but before the fenced INSERT commits is
indistinguishable, on retry, from "AI never ran," so the retry calls AI again. This is a real,
accepted at-least-once property, not a design defect. **Revised this round (round-4 MAJOR): the
crash window is not bounded to a single occurrence** — `packages/domain/src/lease.ts`'s own
`processing_attempt_count < maxAttempts` backstop allows up to `maxAttempts` claim attempts per
event, so the same event can, worst case, accumulate an AI invocation on every one of those
attempts before either a successful persist or the attempt cap forces a terminal DLQ outcome.
Quota accounting (§2.9) now budgets for up to `maxAttempts` AI invocations per in-flight event
(the actual worst case, not one), charged against the AI provider's own quota resource — not
Gmail API units, a separate ceiling entirely (see §2.9).

1. **Step 0** (idempotency check) — if a `gmail_source_enrichments` row already exists for this
   `event_id`, skip to step 7. This still eliminates AI re-invocation on every retry EXCEPT the one
   specific crash window named above.
2. On claim (`claimLease`, unchanged from G2), the processor fetches the Gmail message/thread body
   on demand via the Gmail API (never pre-persisted in D1, per TDD §13's existing "raw bodies not
   part of the central contract" rule) using the opaque `content_locator.ref` already carried on
   the `NormalizedEvent`.
3. Builds `GmailEvidenceBundle` from that fetched content (Gmail-only, structurally isolated from
   cross-channel data per V1's already-sound design).
4. Runs `assertAiSafe()` (existing `packages/provenance` function) against the bundle's provenance.
5. Calls `GmailAIContextBuilder.build(bundle)` → `AIRequest`, then the injected `AIProvider`
   (`WorkersAIProvider` or `NoAIProvider` per ADR-009's existing abstraction — no new provider
   concept needed).
6. Validates the provider's output against `GmailSourceEnrichmentSchema` (JSON Schema per TDD
   §24); on failure, treats it as a `RETRYABLE_FAILURE` (existing `moveToRetryableFailed` path,
   unchanged) rather than silently completing without enrichment. Persists the validated
   `GmailSourceEnrichment` via the lease-fenced INSERT above
   (`gmail_source_enrichments`, `infra/migrations/0002_gmail_connector.sql`, `event_id` PRIMARY
   KEY), attached to the event by `event_id`, carrying Gmail-only provenance.
7. Only then does the event complete (existing `EventProcessor.process()` contract, unchanged).

`NoAIProvider`/AI-disabled and AI-quota-exhausted paths degrade to "no enrichment, event still
completes" — never blocks the durable pipeline on an AI outage, matching ADR-009's own stated
degrade posture. ADR-009's still-owed G3 verification (live re-fetch of the selected model's
license/Customer-Content terms) is tracked as a G3 checkpoint-1 task, not deferred silently.

### 2.5 Complete OAuth lifecycle

`oauth.ts` functions, and where each piece of state lives:

- **`GET /oauth/start`** (new, authenticated owner-only — the single operator, gated the same way
  this project already gates any operator-only action) generates `state` (random, unguessable) and
  a PKCE `code_verifier`, stores both together in a new `oauth_flows` table
  (`state` PRIMARY KEY, `code_verifier`, `created_at`, short TTL e.g. 10 minutes), and redirects to
  Google's consent screen with `code_challenge = SHA256(code_verifier)`.
- **`GET /oauth/callback`** (Google's actual GET-with-query-string redirect, confirmed correct in
  V1): reads `state`/`code` from the query string, looks up and **atomically deletes** the matching
  `oauth_flows` row in one statement (`DELETE ... WHERE state = ? RETURNING code_verifier` — one-
  time, race-safe consumption; a second callback with the same `state` finds no row and is
  rejected, closing the replay/reuse gap V1 left unaddressed), exchanges the code + verifier for
  tokens, encrypts and upserts into `gmail_connections`, and redirects to a code-free confirmation
  URL (unchanged from V1).
- **Reconnect / no-new-refresh-token semantics:** Google only returns a refresh token on the FIRST
  consent for a given `client_id`+account pairing unless `prompt=consent` forces a fresh one.
  `buildAuthUrl` (now `/oauth/start`) always requests `access_type=offline&prompt=consent` so a
  reconnect always yields a usable refresh token — explicit, not assumed. If Google's response
  still omits one (a genuine API-contract violation), `exchangeCode` fails closed (rejects, does
  NOT overwrite the existing connection row with a token-less state).
- **`POST /oauth/disconnect`** (new, authenticated owner-only): calls `users.stop` (stops the Gmail
  watch, since revoking the token alone doesn't stop Google from still trying to push to a
  Pub/Sub topic the operator may want to keep for a future reconnect), then `revokeToken()`
  (Google's `/revoke` endpoint), then deletes the `gmail_connections` row (ciphertext + IV gone,
  not just marked inactive), then cancels any in-flight `oauth_flows` row for that account. Order
  matters: revoke-then-delete means a failure between the two still leaves the token unusable at
  Google even if local cleanup is retried.

### 2.6 Pub/Sub push: body-identity binding + pre-fetch replay suppression

`push-verify.ts` (JWT/OIDC checks unchanged and already sound per V1 + GPT-PM's own confirmation)
is followed by a second, body-level check before any Gmail API call is made:

- Decode the Pub/Sub envelope's `message.data` (base64url), parse the Gmail notification payload
  (`emailAddress`, `historyId`), and **reject unless `emailAddress` exactly matches the connected
  Gmail account** for this connector instance — closes the "authenticated publisher, wrong
  account" gap GPT-PM named.
- Validate the envelope's `subscription` field matches the exact configured subscription resource
  name (not just any subscription the service account happens to have push rights to).
- **Outcome-aware replay suppression before expensive work, as a REAL fenced lease — token, CAS
  reclaim, heartbeat — not just a state column named "lease"** (fixes the round-2 MAJOR, the
  round-3 BLOCKER, and the round-3 MAJOR together, since all three are defects in the same
  mechanism). A one-way permanent-reject nonce, the right primitive for HMAC replay protection, is
  the WRONG primitive for Pub/Sub's own at-least-once delivery — Google's own push-delivery
  reference documents that a 2xx response ACKs the message and an unacknowledged/non-2xx delivery
  is redelivered with the SAME `messageId`, with no exactly-once guarantee. The round-3 review went
  further: V3's design ACKed (200) an unexpired `IN_PROGRESS` duplicate on the assumption the
  winning handler would finish — but if the winner then crashes AFTER that ACK was sent, Pub/Sub
  has no reason to redeliver again (the ACK already told it the message was handled), and nothing
  else resumes the stuck row. Fixed with two changes together: **never ACK a delivery that isn't
  COMPLETED**, and add an **independent scheduled recovery sweep** that does not rely on Pub/Sub
  redelivery at all.
  - `gmail_push_deliveries` (`infra/migrations/0002_gmail_connector.sql`): `message_id` PRIMARY
    KEY, `state` ∈ `{IN_PROGRESS, COMPLETED}`, `lease_token` (fresh `crypto.randomUUID()` per
    claim/reclaim — not present in V3's schema, added per the round-3 MAJOR), `leased_at`,
    `lease_expires_at`, plus the minimal account/history payload needed to resume a traversal
    without the original request (`gmail_account_id`, `start_history_id`) — required precisely
    because the recovery sweep below must be able to resume a delivery with no HTTP request still
    in flight.
  - On receipt: `INSERT (message_id, state='IN_PROGRESS', lease_token=<fresh UUID>, leased_at=now,
lease_expires_at=now+leaseDuration, gmail_account_id, start_history_id) ... ON CONFLICT
(message_id) DO NOTHING`, then read back the row:
    - **Won the insert**: proceed with §2.2's full accept-then-advance traversal, heartbeating
      `lease_expires_at` forward (CAS on the current `lease_token`, same shape as G2's own
      `renewLease`) if the traversal runs long; on success, `UPDATE ... SET state='COMPLETED' WHERE
message_id=? AND lease_token=?` (fenced — a reclaimed/superseded attempt's late completion
      writes zero rows, exactly `lease.ts`'s own ABA protection); **only then** respond `200`.
    - **Row exists, `state='COMPLETED'`**: a safe, finished replay — respond `200` immediately, no
      work done, no Gmail API call made (the actual "expensive duplicate work" round-1 named).
    - **Row exists, `state='IN_PROGRESS'`, lease NOT expired**: another delivery is already being
      handled. Per the round-3 BLOCKER fix, this does **not** respond `200` — it responds a
      **non-2xx** (`409`) so Pub/Sub redelivers later rather than acknowledging away the only
      redelivery that could recover a subsequent crash. This is deliberately less "efficient" (an
      extra redelivery in the common case) in exchange for never losing the recovery path; the
      independent sweep below is the actual backstop regardless.
    - **Row exists, `state='IN_PROGRESS'`, lease EXPIRED (as observed by the SELECT)**:
      **CAS-reclaim, fenced on the CURRENT state AND the observed token AND a fresh expiry
      re-check, all three together at the mutation itself** (round-4 MAJOR fixed the token-only
      fence's heartbeat race; round-5 MAJOR found the remaining gap — fencing on token+expiry alone
      still missed a SELECT→completion→reclaim race, since a row that completed between the SELECT
      and this UPDATE keeps its now-stale token and expired timestamp, and a fence that doesn't
      re-check state would match it anyway. Verified directly against
      `packages/domain/src/transitions.ts`: every G2 lease mutation's WHERE clause is
      `event_id = ? AND state = 'PROCESSING' AND ${fenceSql}` — state is always part of the fence,
      never just token+expiry):
      `UPDATE gmail_push_deliveries SET lease_token=<fresh UUID>, leased_at=<reclaim-now>,
lease_expires_at=<reclaim-now>+leaseDuration WHERE message_id=? AND state='IN_PROGRESS'
AND lease_token=<the token just read> AND lease_expires_at <= <reclaim-now>` — mirrors
      G2's own three-part fence (`state = 'PROCESSING' AND ${fenceSql}`) exactly, not just its
      token/expiry half. Zero rows means the row is no longer `IN_PROGRESS` (already completed), a
      concurrent reclaimer won first, or the original claimant's heartbeat renewed it after the
      SELECT — any of those, this attempt does not proceed. A claimant whose own heartbeat/CAS
      renewal fails for the same reason must itself stop further traversal work (cooperates with
      the same signal `leaseLost` gives the enrichment processor in §2.4).
      The winner retries the full traversal from §2.2's still-untouched cursor A (safe by
      construction: §2.2's crash-safety guarantee makes a retried traversal exactly as safe as the
      first).
  - **Independent scheduled recovery sweep, bounded and indexed** (closes the "ACKed duplicate +
    then the winner crashes = permanently stuck" gap the round-3 BLOCKER named; round-4 MAJOR
    revised the shape — the original unbounded design was a growing-table hot-path scan with no
    supporting index, exactly the shape G2's own `recoverStaleLeases` deliberately avoids). Mirrors
    `packages/domain/src/lease-recovery.ts` structurally, not just conceptually:
    - `infra/migrations/0002_gmail_connector.sql` adds `idx_gmail_push_deliveries_lease ON
gmail_push_deliveries(lease_expires_at, message_id) WHERE state = 'IN_PROGRESS'` — a **partial**
      index, fixing the round-5 MAJOR (V5's index had no `WHERE` clause, so retained `COMPLETED`
      rows' expired timestamps would dominate the expiry-ordered range the sweep scans before its
      `LIMIT` finds the few genuinely active rows). Now the true shape of G2's own
      `idx_ingest_events_processing_lease` (`infra/migrations/0001_ingest_outbox.sql:159-161`,
      verified this round to carry `WHERE state = 'PROCESSING'`, not a bare index), not just the
      same column order.
    - A Cron Trigger, the same mechanism G2 already uses for its own stale-lease-recovery sweep,
      runs `SELECT message_id, gmail_account_id, start_history_id, lease_token FROM
gmail_push_deliveries WHERE state = 'IN_PROGRESS' AND lease_expires_at <= ? ORDER BY
lease_expires_at LIMIT ?` (explicit `batchSize`, matching `recoverStaleLeases`'s own
      `LIMIT ?` bound) — never an unbounded scan.
    - Each candidate row is CAS-reclaimed using the exact same triple-fenced UPDATE above
      (state + token + fresh expiry re-check), then resumed using its own persisted
      `gmail_account_id`/`start_history_id` — no dependency on a future Gmail-side event or a fresh
      Pub/Sub redelivery
      to notice the stuck row.
    - `COMPLETED` rows are retained only long enough to serve the replay-suppression check (§3 adds
      a cleanup test asserting old `COMPLETED` rows are prunable on a schedule) so the table does
      not grow unboundedly even on the happy path.
  - G2's `ingestEvent()` idempotency key remains the final correctness guarantee underneath all of
    this (unchanged) — the lease is an optimization against redundant Gmail API calls and stuck
    work, not the correctness boundary, the same relationship G2's own processing lease already has
    to its own idempotency key.

### 2.7 KEK: dedicated random secret, not a hashed human passphrase; versioned key ring

`WORKER_SECRET` is **not** hashed to derive the KEK. Instead: a dedicated, randomly-generated
256-bit key, base64-encoded, provisioned directly as a Worker Secret (`GMAIL_KEK_V1`) —
`crypto.subtle.importKey('raw', base64Decode(env.GMAIL_KEK_V1), {name:'AES-GCM'}, false,
['encrypt','decrypt'])`. This has full 256 bits of entropy by construction, unlike a SHA-256 digest
of an operator-chosen passphrase (V1's design, which GPT-PM correctly flagged as
length-guaranteed but not entropy-guaranteed).

- `kek_version` becomes a real key-ring index: `GMAIL_KEK_V{n}` Worker Secret bindings, one per
  version; `gmail_connections.kek_version` records which one encrypted that row.
- **AAD (additional authenticated data) binds each ciphertext to `gmail_account_id || kek_version`**
  (`crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData}, key, plaintext)`) — closes the
  "ciphertext silently transplanted between account rows" gap; a ciphertext decrypted under the
  wrong account/version's AAD fails authentication rather than silently succeeding (irrelevant at
  today's single-account MVP1 scale, but free to add now and exactly the kind of forward-looking
  discipline this project already applies elsewhere, e.g. TDD §41's key-ring pattern).
- **Rotation protocol** (was previously undefined — "additive" was asserted, not designed): to
  rotate, provision `GMAIL_KEK_V{n+1}`, then re-encrypt the single `gmail_connections` row (decrypt
  under `V{n}`, encrypt under `V{n+1}`, update `kek_version`) as one atomic UPDATE — trivial at
  single-row MVP1 scale; the versioned design exists so this remains trivial if the connection
  count ever grows, not because MVP1 itself needs concurrent key versions in flight.

### 2.8 Authenticated message/thread drill-down (explicit G3 DoD item, previously missing)

New owner-only authenticated endpoints on `services/gmail-connector`:
`GET /gmail/messages/:contentLocatorRef` and `GET /gmail/threads/:contentLocatorRef`. Each: checks
the caller is the single authenticated operator (same gate as `/oauth/start`/`/oauth/disconnect`),
resolves the opaque `content_locator.ref` to a real Gmail `message.id`/`thread.id`, and calls
`messages.get`/`threads.get` using a token obtained by **the actual path this design stores**
(corrected — round-2 MAJOR: this design never stores an access token, only an encrypted refresh
token, so "the stored access token" in V2 named something that doesn't exist): decrypt the
versioned refresh token (§2.7) → call Google's token endpoint to exchange it for a short-lived
access token, held only in memory for this one request → call `messages.get`/`threads.get` → the
in-memory access token is discarded once the request completes, never persisted anywhere. Returns
the body directly in the response with `Cache-Control: no-store` (matching TDD §33.1's existing
drill-down discipline for the Telegram path) — never written to D1, logs, or metrics. Explicit 404
handling for a since-deleted Gmail message (`MESSAGE_DELETED` events, per §2.3, may still have
drill-down requested against them) returns a clear "no longer available" response rather than a
raw Gmail API error.

### 2.9 Gmail API / D1 quota: separate from Queue-dispatch budget

`packages/domain/src/budget.ts`/`queue_budget_counters` stays exactly what it already is — the
2,500/day Queue-dispatch soft budget for G2's outbox reconciler. It is not touched or reused by
G3. A new, separate `gmail_api_budget_counters` table (same UPSERT-reservation shape, different
ceiling) tracks actual Gmail API unit consumption per TDD §35's own required accounting (D1
read/write, Queue, request, and NOW Gmail-API-unit counts, at both the 200/day normal and
1,000/day stress simulation volumes already established by G2's own `tests/quota/budget.test.ts`
harness — G3 extends that same harness rather than inventing a separate one). The budget model
accounts for realistic per-event Gmail API cost: `history.list` (2 units) + `messages.get` (20
units) per new message, plus periodic `watch`/`renewWatch` (100 units) and bounded 404-recovery
`messages.list` (5 units) calls — not just the empty-poll baseline V1 computed.

**Short-window per-user limiter, redesigned for the round-3 MAJOR** (V3's in-memory token bucket
cannot enforce a shared ceiling: Cloudflare's own documentation states requests are not guaranteed
to reach the same Worker instance and isolate memory is not shared across instances, so concurrent
isolates each pacing against their own local bucket can collectively exceed Gmail's real
6,000-units/min-per-user ceiling — `EXTERNAL_ASSUMPTIONS.md:185`, confirmed live in G0 — while every
local check reports "within limit"). Replaced with a D1-based shared atomic reservation, the exact
`INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING` UPSERT discipline
`packages/domain/src/budget.ts:reserveBudget` already uses, applied to a fixed 60-second time
bucket instead of a calendar day:

- `gmail_rate_reservations` (`infra/migrations/0002_gmail_connector.sql`): `(gmail_account_id,
window_start_epoch_minute)` PRIMARY KEY, `units_reserved`.
- Before every Gmail API call, reserve its known unit cost atomically: `INSERT INTO
gmail_rate_reservations (gmail_account_id, window_start_epoch_minute, units_reserved) VALUES (?,
?, ?) ON CONFLICT (gmail_account_id, window_start_epoch_minute) DO UPDATE SET units_reserved =
units_reserved + ? WHERE units_reserved + ? <= 6000 RETURNING units_reserved` — zero rows back
  means the current 60-second window is already at or over the margin-adjusted ceiling; the caller
  waits for the next window (or the sweep's next tick) rather than calling Gmail. This is the same
  UPSERT-race-safety property `reserveBudget` already has under concurrent callers, now shared
  correctly across isolates because D1, not isolate memory, is the source of truth.
- The in-memory pacing V3 proposed may still exist as a purely local, non-authoritative
  optimization (avoid firing every reservation-approved call in the same instant), but the D1
  reservation above is what actually enforces the ceiling — a genuine `429` from Google is still
  honored as an unconditional backoff regardless of what the reservation table says (belt-and-
  suspenders, since Google's own enforcement is the real source of truth, not this table).
- **AI-provider quota, separated from Gmail API units AND measured in the platform's actual unit
  (fixes the round-4 MAJOR on resource separation, and the round-5 MAJOR on unit correctness
  together — both are defects in the same reservation)**: a `WorkersAIProvider` call consumes the
  separate Workers AI `HARD_ZERO` budget, not a Gmail API unit — and that budget's real ceiling,
  verified directly against `docs/architecture/EXTERNAL_ASSUMPTIONS.md` §C, is **"10,000 Neurons
  per day," not a call count** — two invocations can consume very different Neuron amounts
  depending on model/input/output size, so an invocation counter can read "within limit" while the
  actual Neuron allocation is already exhausted. `gmail_ai_neuron_budget`
  (`infra/migrations/0002_gmail_connector.sql`, same UPSERT-reservation shape as
  `gmail_rate_reservations`, its own 10,000/day ceiling) reserves a **conservative, deterministic
  per-call Neuron estimate for the selected model** before each `AIProvider` call — the exact
  estimate is a G3 checkpoint-1 task (alongside ADR-009's already-tracked live license/terms
  re-fetch), since no per-model Neuron cost is documented in this repository today and one must be
  established (and kept conservative, i.e. an overestimate) before implementation can reserve
  against it correctly. If the Workers AI response exposes actual Neuron usage, the reservation is
  reconciled to the real figure after the fact (never before — reservation must happen BEFORE the
  call, since the cost isn't known with certainty until after). A reservation that cannot be granted
  (remaining daily allocation cannot safely cover the conservative estimate) fails closed — the
  processor degrades to the `NoAIProvider` path (§2.4's existing "no enrichment, event still
  completes" degrade posture), never calls the provider un-reserved. Worst-case accounting covers
  **up to `maxAttempts` reservations per in-flight event** (§2.4's revised guarantee: the crash
  window is not bounded to one occurrence — `packages/domain/src/lease.ts`'s own
  `processing_attempt_count < maxAttempts` backstop allows an event up to `maxAttempts` claim
  attempts before terminal DLQ), now correctly expressed as Neurons reserved, not calls counted.
  ADR-009's own required AI-quota-exhausted test now asserts the `NoAIProvider`/degrade path
  triggers correctly both under Neuron-allocation exhaustion and under this worst-case
  `maxAttempts` multiplier.
- The test suite (§3) adds a **concurrent-simulated-isolates** case: two or more independent
  reservation attempts against the same `gmail_account_id`/window, run concurrently (not
  sequentially) against the same D1 instance, and asserts their combined `units_reserved` can never
  exceed the configured margin below 6,000 — the actual claim the in-memory design could never
  prove — alongside the existing recovery-burst case (a multi-hundred-message bounded recovery in
  one tick, asserting no simulated call sequence would exceed the ceiling).

## 3. Testing obligations (§62, §69, §70 DoD — supersedes V3's §3, folding in all remediation)

- Ingress: a test asserts `services/gmail-connector` has no static or runtime import of
  `ingestEvent`/`@pdos/domain`'s ingest module — only the service-binding HTTP call to
  `/ingest/gmail`; a live-shaped test signs a request as connector `gmail`/`GMAIL_V1_HMAC_SECRET`
  and confirms `services/ingest`'s REAL, unmodified handler accepts it (closes round-2 BLOCKER 1 by
  proving compatibility with the actual handler, not just describing it).
- Cursor, multi-page crash safety (round-2 BLOCKER 2, the case V2's single-page test didn't cover):
  a mocked Gmail client returns 2 pages for one `startHistoryId` (page 1 has `nextPageToken`, page
  2 does not); accept all of page 1's events, then simulate a crash before page 2 is fetched;
  assert `source_cursors.cursor_value` is UNCHANGED (still A); assert the next tick re-fetches from
  A, safely no-ops page 1's already-accepted events, processes page 2 for real, and only then
  advances the cursor to page 2's `historyId`.
- History-normalization matrix: one test per row of §2.3's corrected table (now against the REAL
  `NormalizedEventSchema.parse()`, not just this document), explicitly including the
  `labelsAdded`+`labelsRemoved`-in-one-record case asserting two DISTINCT `idempotency_key`s (the
  exact collision round-2 found).
- AI pipeline: `MESSAGE_DELETED` events complete via the `NO_CONTENT_DELETED` marker with zero
  Gmail API calls made (assert the mocked Gmail client is never invoked for a deletion event); a
  crash-after-enrichment-write-before-`PROCESSED` test asserts a retried processing attempt reuses
  the existing `gmail_source_enrichments` row rather than calling `AIProvider` a second time.
- **Lease-fenced enrichment, the round-3 BLOCKER regression test (the exact G2-style ABA case)**:
  attempt A claims the event and calls AI; A's lease expires before it persists; attempt B is
  legitimately reclaimed and completes first; A's now-stale fenced INSERT (using its now-superseded
  `leaseToken`) must write zero rows and return `RETRYABLE_FAILURE`/`LEASE_LOST` rather than
  succeeding — assert exactly one `gmail_source_enrichments` row exists for the event afterward, and
  it was authored by B's token, not A's. A second test asserts `ClaimedEvent.leaseToken` is passed
  through unchanged from `claimLease`'s `claim.token` and that every existing G2 processor test
  (including `noopProcessor`) still compiles and passes unmodified — proving the contract extension
  is additive, not breaking.
- **AI-invocation crash-ambiguity test (round-3 MAJOR)**: simulate a successful `AIProvider` call
  followed by a crash before the fenced INSERT commits; assert the retried attempt calls
  `AIProvider` a second time (this is the accepted, documented behavior, not a bug) and that exactly
  one `gmail_source_enrichments` row exists afterward regardless of how many AI invocations occurred.
- **Repeated-crash worst-case test (round-4 MAJOR, unit corrected round-5)**: simulate the
  crash-after-AI-success-before-persist window recurring on every attempt up to the configured
  `maxAttempts` cap; assert AI is invoked up to `maxAttempts` times for the one logical event (not
  silently capped lower), assert `gmail_ai_neuron_budget` accounting reflects `maxAttempts` worth of
  the conservative per-call Neuron estimate — not an invocation count — and assert the event still
  reaches a correct terminal outcome (persisted enrichment or DLQ per G2's own attempt-cap
  machinery), not stuck.
- **Neuron-allocation-exhaustion degrade test (round-5 MAJOR)**: seed `gmail_ai_neuron_budget` near
  the 10,000/day ceiling such that the conservative per-call estimate cannot be safely reserved;
  assert the reservation is refused, the processor degrades to `NoAIProvider` (no unreserved AI
  call is ever made), and the event still completes via the existing degrade posture — proving the
  budget is enforced in Neurons, not merely in call count.
- OAuth: `state`/verifier one-time-consumption test (second callback with the same `state` is
  rejected); reconnect-yields-refresh-token test; disconnect ordering test (revoke called before
  local row deletion, verified via call-order assertion on a mocked Google client).
- Pub/Sub: wrong-`emailAddress`-in-body rejected even with a valid JWT; a **reserve → simulated
  crash → same-`messageId` redelivery → successful recovery** test (the scenario round-2 named) —
  first delivery wins the lease, "crashes" before completing, lease is later found expired,
  redelivery reclaims it (fresh `lease_token`, old token's completion attempt now fails the CAS) and
  completes the traversal; a genuinely-`COMPLETED` replay is acked with zero Gmail API calls (assert
  the mocked Gmail client was never invoked for that case specifically).
- **Round-3 BLOCKER regression test — ACK-then-crash recovery without a new Gmail event**: delivery
  A wins the claim; a concurrent delivery B arrives while A's lease is still unexpired and asserts
  it receives a **non-2xx** response (not `200`) rather than acknowledging the message away; A then
  "crashes" before completing; assert the message is NOT durably lost — the independent scheduled
  sweep (not a fresh Pub/Sub redelivery) finds the expired `IN_PROGRESS` row, reclaims it using its
  own persisted `gmail_account_id`/`start_history_id`, and completes the traversal with no further
  Gmail-side event or redelivery involved.
- **Concurrent-expired-reclaim test (round-3 MAJOR)**: two simulated reclaim attempts race against
  the same expired `IN_PROGRESS` row; assert exactly one wins the CAS (gets a fresh `lease_token`)
  and the other's reclaim affects zero rows; assert a stale winner's later `COMPLETED` write (using
  its now-superseded token) also affects zero rows.
- **Heartbeat-vs-reclaim race regression test (round-4 MAJOR, the exact G2-style ABA case
  requested)**: read token A as expired (SELECT observes a stale `lease_expires_at`); before the
  reclaim UPDATE runs, the live holder heartbeats and renews `lease_expires_at` while retaining
  token A; assert the reclaimer's triple-fenced UPDATE (`state='IN_PROGRESS'` AND token A AND
  `lease_expires_at <= now`) affects zero rows, the lease stays with the live holder under token A,
  and only one traversal runs — not two. A companion test asserts a claimant whose own
  heartbeat/CAS renewal fails (lease already reclaimed) stops further traversal work rather than
  continuing under a lease it no longer holds.
- **Completion-vs-reclaim race regression test (round-5 MAJOR, the specific gap the round-4 fix
  left)**: read token A as expired `IN_PROGRESS` (SELECT); before the reclaim UPDATE runs, the
  original handler legitimately completes and the row transitions to `COMPLETED` (still carrying
  token A and its now-expired timestamp); assert the reclaimer's triple-fenced UPDATE — now
  requiring `state='IN_PROGRESS'` at mutation time — affects zero rows and performs no Gmail work,
  rather than incorrectly "succeeding" and starting a redundant traversal against an
  already-completed delivery.
- **Sweep query-plan and index-coverage test (round-4 MAJOR, strengthened round-5)**: `EXPLAIN QUERY
PLAN` on the sweep's `SELECT ... WHERE state = 'IN_PROGRESS' AND lease_expires_at <= ? ORDER BY
lease_expires_at LIMIT ?` confirms it uses `idx_gmail_push_deliveries_lease`. Not sufficient by
  itself (round-5 finding: naming the index doesn't prove it avoids scanning retained `COMPLETED`
  rows) — the test seeds many old `COMPLETED` rows with expired timestamps alongside a small set of
  genuinely active expired `IN_PROGRESS` rows, and asserts the sweep still finds and reclaims the
  active set efficiently, exercising the partial index's actual purpose rather than only its name.
  An over-batch test seeds more expired `IN_PROGRESS` rows than `batchSize` and asserts exactly
  `batchSize` are reclaimed in one sweep tick, with the remainder picked up on the next tick — never
  an unbounded single-invocation scan.
- Crypto: KEK-entropy test (assert the Worker Secret is decoded as 32 raw bytes, not hashed from a
  string); AAD-mismatch test (ciphertext from account A's AAD fails to decrypt under account B's
  AAD); IV-uniqueness property test (unchanged from V1).
- Drill-down: message and thread retrieval both work via the refresh-token → short-lived
  access-token exchange path (assert no access token is ever written to D1); deleted-message 404
  path returns a clean error, not a raw Gmail API error; response carries `Cache-Control:
no-store`.
- Quota: extended `tests/quota/budget.test.ts` harness simulates 200/1,000 events/day including
  realistic `messages.get`/`history.list`/`watch` calls, asserts Gmail API units/day and D1
  ops/day both stay under their respective ceilings, asserts `queue_budget_counters` is untouched
  by any Gmail-specific operation, AND a recovery-burst case (round-2 MAJOR) simulating a
  multi-hundred-message bounded recovery in one tick, asserting no simulated call sequence would
  exceed the 6,000-units/min-per-user ceiling.
- **Concurrent-simulated-isolates shared-limiter test (round-3 MAJOR)**: two or more independent
  `gmail_rate_reservations` UPSERT attempts for the same `gmail_account_id`/window run concurrently
  (via `Promise.all`, not sequential awaits, to actually exercise the D1 UPSERT's own race
  handling) against the same D1 instance; assert their combined accepted `units_reserved` never
  exceeds the configured margin below 6,000, proving the shared reservation — unlike the discarded
  in-memory bucket — actually holds under concurrency rather than merely asserting it does.
