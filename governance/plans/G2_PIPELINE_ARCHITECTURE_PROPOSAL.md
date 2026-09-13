# G2 pipeline architecture — 4-specialist proposal + Claude verification, pending GPT-PM decision

**Process followed (operator instruction, 2026-09-12):** specialist agents propose first, Claude
verifies against primary sources, then GPT-PM decides. Four agents were run in parallel:
`type-design-analyzer`, `database-reviewer`, `code-architect`, `architect`. This document is the
reconciliation — it is NOT an implementation, no files under `packages/`, `services/`, or
`infra/migrations/` have been created or edited yet.

## 1. Convergent finding — verified FACT, not an agent opinion

All four agents independently found the same defect: **the Processing Reconciler's query, as
written in the binding spec itself, cannot execute as a single index-covered query against the
schema that was built for it.**

Verified directly by Claude (not taken on an agent's word):

- `docs/architecture/TDD.md:840-846` (the binding spec, not just the ADR) writes the reconciler
  query as `state IN (ACCEPTED, RETRYABLE_FAILED) AND next_attempt_at <= now AND attempt_count <
  MAX_PROCESSING_ATTEMPTS`.
- `ACCEPTED`/`RETRYABLE_FAILED` are `ingest_events.state` values
  (`infra/migrations/0001_ingest_outbox.sql:99`).
- `next_attempt_at`/`attempt_count` exist only on `processing_outbox`
  (`infra/migrations/0001_ingest_outbox.sql:134-135`).
- The only index built for this query, `idx_processing_outbox_reconciler`, is on
  `processing_outbox(state, next_attempt_at)` (`infra/migrations/0001_ingest_outbox.sql:142`),
  whose `state` domain is `PENDING|DISPATCHED|RETRY_PENDING|BUDGET_DEFERRED`
  (`infra/migrations/0001_ingest_outbox.sql:132`) — it has no `ACCEPTED`/`RETRYABLE_FAILED` value at
  all, and `processing_outbox` (`docs/architecture/TDD.md:831-838`) has no terminal state either.

As literally written, the query needs a join with an unconstrained leading index column — a
growing-table scan in the hot path, which `docs/architecture/TDD.md:1568` forbids outright
("no growing-table full scan in hot path"). This must be resolved before `infra/migrations/
0001_ingest_outbox.sql` is applied to any live D1 — SQLite cannot `ALTER` a `CHECK` constraint
afterward, so a late fix means a destructive table rebuild of the pipeline's central table.

## 2. Four different resolutions were proposed — this is the actual decision GPT-PM needs to make

| Agent | Resolution | Satisfies TDD's queue-expiry-recovery requirement? |
|---|---|---|
| `architect` | Add two new terminal states, `'DONE'`/`'TERMINAL'`, to `processing_outbox.state`'s CHECK. Reconciler query becomes purely `processing_outbox`-native: `state IN ('PENDING','RETRY_PENDING','BUDGET_DEFERRED','DISPATCHED') AND next_attempt_at <= now`, fully index-covered. | **Yes** — `DISPATCHED` stays in the query with `next_attempt_at` set to `dispatched_at + VISIBILITY_TIMEOUT`, so a lost message becomes due again on its own. |
| `code-architect` | No schema change. Query `processing_outbox.state IN ('PENDING','RETRY_PENDING','BUDGET_DEFERRED')` only; treat `DISPATCHED` as terminal-by-convention after success. | **No** — `DISPATCHED` is excluded from the reconciler query entirely, so a message lost after being marked `DISPATCHED` (the queue-expiry case) would never be re-picked-up by anything. |
| `database-reviewer` | Flagged the ambiguity, recommended documenting an explicit mapping, leaned toward a 3-state query including `BUDGET_DEFERRED`. Did not resolve the `DISPATCHED`-recovery question. | Not addressed. |
| `type-design-analyzer` | Modeled the reconciler-eligible type as `PENDING`/`RETRY_PENDING` only. | **No** — same gap as `code-architect`: `DISPATCHED` never re-enters. |

**Claude's verification: `architect`'s resolution is the only one of the four that satisfies
`docs/architecture/TDD.md:870`** ("This remains true even if the old outbox row says
`DISPATCHED`" — i.e., the reconciler MUST be able to re-dispatch a `DISPATCHED` row after a
simulated >24h queue outage, `docs/architecture/TDD.md:874-878`). The other three designs have a
live, verified gap on exactly this named resilience case. This is not a style preference between
four equally-valid options — two of the four proposals do not meet a requirement the spec states
explicitly.

**Recommendation to GPT-PM: adopt `architect`'s schema resolution** (add `DONE`/`TERMINAL` to
`processing_outbox.state`), and record it as an addendum to `core/adr/ADR-006-durable-ingest-
outbox.md` before any implementation proceeds, per `docs/architecture/TDD.md`'s own §17 wording
being ambiguous enough to need one.

## 3. Second convergent-but-partially-missed bug: an event at the attempt cap is invisible, not DLQ'd

`docs/architecture/TDD.md:845` / `core/adr/ADR-006-durable-ingest-outbox.md:43` both write
`attempt_count < MAX_PROCESSING_ATTEMPTS` as a **SQL WHERE filter**. If implemented literally (as
`code-architect`'s and `type-design-analyzer`'s proposals both do), an event that reaches
`attempt_count = MAX_PROCESSING_ATTEMPTS` is **excluded** from the query that is supposed to
promote it to DLQ — it silently sits non-terminal forever, `dead_letter_events` stays empty, and
`docs/architecture/TDD.md:911` ("DLQ count > 0 => OPS RED") reports a false-green signal on a real,
permanent processing failure.

Only `architect`'s proposal catches and fixes this: claim rows unconditionally via one `UPDATE ...
RETURNING attempt_count`, then partition in memory — `attempt_count <= MAX` dispatches,
`attempt_count > MAX` goes to `deadLetterBatch()` — at zero extra D1 query cost. This should be
adopted regardless of which reconciler-schema resolution GPT-PM picks in §2.

## 4. Structural verification: package/service naming

`docs/architecture/TDD.md:2319-2381` (the binding repo-layout section) already names:
`services/api, services/ingest, services/processor, services/resolver, services/decision,
services/notification, services/reporting, services/content-request-broker`, and
`packages/contracts, packages/domain, packages/policy, packages/provenance, packages/telemetry,
packages/testkit`. There is **no** `services/reconciler` and **no** `packages/db`/`packages/
outbox` anywhere in this canonical layout.

- `architect`'s naming (`packages/domain`, `packages/policy`, `packages/telemetry`,
  `packages/testkit`; two Workers — `services/ingest` with both `fetch` and `scheduled` handlers,
  `services/processor` for the queue) matches this canonical layout exactly, and correctly does not
  invent a `services/reconciler` directory that the spec never names.
- `code-architect`'s naming (`packages/db`, `packages/outbox`, a separate `services/reconciler`)
  does not match the spec's own prescribed structure.

**Recommendation: adopt `architect`'s package/service boundaries** for this reason alone, independent
of the reconciler-schema question in §2.

**Open gap, unaddressed by any of the four agents:** `services/resolver/` is named in the spec's
canonical layout and in `core/adr/ADR-011-queue-consumer-runtime.md:108` ("`services/processor/`
and `services/resolver/` must be written to the light-consumer contract from the start"), but none
of the four proposals populate it — `architect`'s design folds candidate-scoring inline into
`services/processor`'s consumer with a `(reserved for G5)` comment. This may be the correct call
(topic/candidate resolution semantics are G5-owned per the migration's own scope note), but it
should be confirmed with GPT-PM rather than left as a silent omission four proposals in a row.

## 5. Other findings, independently useful regardless of §2's outcome

- **`queue_budget_counters` check-then-increment race** (`database-reviewer`, confirmed by Claude
  against `infra/migrations/0001_ingest_outbox.sql:175-178`'s own comment describing a two-step
  "check and increment"): a real lost-update race under concurrent dispatch. `architect`'s fix
  (`INSERT ... ON CONFLICT(day) DO UPDATE ... WHERE dispatched_count + ?n <= ?cap RETURNING
  dispatched_count`) is atomic and self-bootstraps the day row; `database-reviewer`'s independently
  proposed fix is equivalent in spirit; `code-architect`'s bare `UPDATE ... WHERE dispatched_count <
  2500` does not bootstrap a new day's row and needs a separate insert step that reopens a smaller
  race. **Adopt `architect`'s single-statement upsert.**
- **`devices` table breaks the migration's own stated scope-boundary rule**
  (`database-reviewer`, confirmed: `infra/migrations/0001_ingest_outbox.sql:1-15`'s header argues
  against creating tables ahead of the gate that needs them, then `:32-40` creates `devices` for
  G7's benefit anyway). Needs an explicit GPT-PM/operator decision: drop it from this migration, or
  document it as a deliberate, reasoned exception.
- **Provenance DAG multi-hop question** (`database-reviewer`, `type-design-analyzer`): whether
  `ingest_event_routing_hint_provenance.provenance_event_id` ever needs resolving back into another
  `ingest_events` row (recursively) at G2 read time, per `core/adr/ADR-005-value-provenance-dag.md`'s
  composition rule (`ai_safe(value) = all provenance ancestors are AI_ALLOW`, line 37, which is
  stated as a transitive/full-ancestry walk). ADR-005 does not resolve whether this reaches into the
  D1 schema's routing-hint tables or stays purely an in-memory `packages/provenance` concern.
  **Genuinely unresolved — needs a GPT-PM/operator decision, not a silent pick.**
- **`routing_hints` array is unbounded** (`architect`, new finding not raised by the other three):
  `packages/contracts/src/event.ts`'s `routing_hints` field has no `.max()`, so CPU parse cost scales
  unboundedly against the ~10ms Free CPU ceiling even though the D1 query count stays fixed at 4 via
  a multi-row insert. Needs a `MAX_ROUTING_HINTS` cap (architect suggests 16) with its own contracts
  test.
- **CPU cannot be measured inside a Worker** (`architect`, `code-architect`, independently
  converging on the same existing precedent): `scripts/probes/cloudflare-free-cpu/`'s own header
  comment states `Date.now()` does not advance during Worker compute — an in-Worker millisecond
  assertion silently measures zero and always passes. The p95 ≤8ms CPU target
  (`core/adr/ADR-011-queue-consumer-runtime.md:51-52`) must be an operator-run, out-of-band dashboard
  reading, never a green unit test citation.

## 6. Full agent output

The complete `architect` proposal (recommended base design, §2/§4 above) and the other three
agents' full findings are preserved in this session's transcript and available on request; this
document is the synthesis GPT-PM should review first. If GPT-PM wants the raw per-agent text
verbatim rather than this reconciliation, ask and it will be supplied in full per the standing rule
against shortening a review payload.

## 7. Three additional defects, found by an independent external audit and Claude-verified

Not raised by any of the four agents above, but material to the same G2 decision and verified
directly by Claude against primary sources (not taken on the audit's word) before this document was
sent to GPT-PM. Full verification record: `reports/G2_external_audit_verification.ru.html`.

- **Provenance fail-open in `packages/provenance/src/dag.ts:55-73`.** `isAiSafe()` checks only
  `node.ai_policy === 'DENY'`, never `=== 'ALLOW'`. At the TypeScript type level `AiPolicy` has no
  third value, but the check is not bound to the `zod` validation in `packages/contracts/src/
  provenance.ts` (`AiPolicySchema` / `.strict()`) — any `ProvenanceNode` built without going through
  that schema, carrying an arbitrary `ai_policy` value (including `undefined`), passes as safe as
  long as it has no ancestors. `provenance.ts:9`'s own comment already says the shape layer is not
  enforcement ("a type that carries an ai_policy field does not by itself stop anyone from
  serializing it") — this is exactly the enforcement gap at the one place (`dag.ts`) that is
  supposed to close it. Separately: an `ALLOW` node with empty `provenance: []` is accepted as a
  valid root purely by a doc-comment convention ("never used to represent ancestry not loaded yet"),
  with nothing in the type system or at runtime distinguishing a genuine `SourceEvent` leaf from any
  other node that happens to carry an empty array. Needs: `isAiSafe` to require `ai_policy ===
  'ALLOW'` explicitly (not merely `!== 'DENY'`), and either a runtime `AiPolicySchema.parse()` at
  the `ProvenanceNode` construction boundary or separate root/derived node types per the original
  audit's suggestion.
- **`infra/migrations/0001_ingest_outbox.sql` allows a `telegram` source to carry an `ALLOW`
  policy.** `source_policies` (:57-63) has independent `CHECK`s on `source IN ('telegram','gmail')`
  and `ai_policy IN ('ALLOW','DENY')`, with no composite constraint forbidding `telegram + ALLOW`.
  In `ingest_events` (:79-91), `source`, the FK to `source_accounts`, and the FK to
  `source_policies` are three independent columns with nothing tying them together — an event's own
  `source` need not match its `source_account`'s `source`, nor its `source_policy`'s `source`.
  Combined with the `dag.ts` gap above, a lost- or wrong-provenance Telegram event could resolve to
  an AI-safe node. Needs a composite CHECK (e.g. `CHECK (NOT (source = 'telegram' AND ai_policy =
  'ALLOW'))` on `source_policies`, plus a trigger or application-level invariant tying
  `ingest_events.source` to both referenced rows' `source` — SQLite has no native cross-table CHECK).
- **`idempotencyKey()` (`packages/contracts/src/event.ts:105-111`) collides across sequential
  `MESSAGE_UPDATED` events.** The key is a pure function of `source_account_id`, `source_event_id`,
  `event_type` only. Two distinct edits of the same provider message both produce
  `event_type = 'MESSAGE_UPDATED'` with the same account/event id, so they generate an identical
  key and the second insert collides on `idx_ingest_events_idempotency` (UNIQUE) — the real update
  is silently dropped as a duplicate rather than recorded. Needs a monotonic revision/version
  component (e.g. provider `edit_date`/`historyId`) folded into the key for `MESSAGE_UPDATED`.

## Status

**2026-09-12: GPT-PM returned `VERDICT: BLOCKER`.** Full ruling in `core/DECISION_LOG.md`'s
"Rosetta plan GO obtained and executed; GPT-PM returns BLOCKER on the G2 proposal" entry. Summary:
§2's proposed pure-`processing_outbox` reconciler schema is rejected (must stay joined against
`ingest_events.state`, index-covered, proven via `EXPLAIN QUERY PLAN`); §3's attempt-cap remedy is
rejected (DLQ transition must be atomic with the failing processing transaction, not a separate
reconciler claim); a new BLOCKER was found that none of the four agents or the audit caught
(stale-`PROCESSING` recovery is unspecified -- no processing lease/claim-expiry protocol exists
anywhere in this repo); plus 4 MAJORs (devices table drop, provenance fail-open needs discriminated
node schemas not just a `!== 'ALLOW'` flip, telegram+ALLOW needs structural composite-FK
enforcement, idempotency fix needs a contract/migration change) and one entirely new MAJOR
(`ProvenanceValueSchema` doesn't match the frozen TDD's `ProvenanceValue<T>` shape). §4 and the
provenance-DAG and budget-counter/routing-hints/CPU-measurement recommendations were confirmed.

**Nothing in `packages/`, `services/`, or `infra/migrations/` has been created or modified.**
**G2 implementation must not start** until a revised proposal addresses all 3 BLOCKERs and 4 MAJORs
above and receives a fresh GPT-PM ruling under a new Rosetta plan/GO.

**2026-09-12/13: Revision 2 filed.** Three specialist agents (`database-reviewer`,
`type-design-analyzer`, `architect`) redesigned fixes for every BLOCKER/MAJOR above, executably
validated in a scratch SQLite harness (`PRAGMA foreign_keys=ON`, a 7-case negative-control insert
matrix, `EXPLAIN QUERY PLAN` proof of index-covered access with a negative control showing the plan
change without it) and a clean `tsc --noEmit` run against the repo's own tsconfig and installed
zod. Full document: `governance/plans/G2_PIPELINE_ARCHITECTURE_PROPOSAL_V2.md`. Sent to GPT-PM for a
fresh ruling under Rosetta plan `personal-decision-os-2026-09-12T21-44-44-733Z-f21028`.

**2026-09-13: GPT-PM returned `VERDICT: BLOCKER` on V2** (2 BLOCKER/2 MAJOR -- a materially
narrower set than Round 1's 3+4, with all of Round 1's findings confirmed closed). Revision 3
(`governance/plans/G2_PIPELINE_ARCHITECTURE_PROPOSAL_V3.md`) addresses the remaining 4 findings,
executably validated the same way. Sent to GPT-PM under Rosetta plan
`personal-decision-os-2026-09-12T23-05-18-895Z-8f6c31`; verdict pending recording under a
follow-up plan.
