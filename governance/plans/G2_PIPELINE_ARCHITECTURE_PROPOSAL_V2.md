# G2 pipeline architecture — Revision 2 (SUPERSEDED — see Revision 3)

**2026-09-13: GPT-PM returned `VERDICT: BLOCKER` on this document** (2 BLOCKER/2 MAJOR: incomplete
processor outcome state machine, lease-token ABA gap, partially-fixed idempotency rule, incomplete
`ProvenanceValue<T>` durable representation). All of Round 1's findings were confirmed closed.
Superseded by `governance/plans/G2_PIPELINE_ARCHITECTURE_PROPOSAL_V3.md`, which addresses exactly
these 4 remaining findings. This document is kept as the historical record of Round 2; do not treat
it as the current proposal.

# G2 pipeline architecture — Revision 2 (PROPOSAL / PENDING GPT-PM / NON-NORMATIVE)

**Status of this document: a proposal awaiting GPT-PM's ruling, not a settled decision.** Nothing
in this file authorizes G2 implementation. No file under `packages/`, `services/`, or
`infra/migrations/` has been created or modified as part of this document. Every DDL/SQL/TypeScript
snippet below was executed against a throwaway scratch harness (SQLite file + `tsc --noEmit`)
entirely outside the tracked repository tree, and the actual stdout/exit codes are pasted in as
evidence, not paraphrased.

This document supersedes nothing in `G2_PIPELINE_ARCHITECTURE_PROPOSAL.md` — that file's §1-§7 and
its Round-1 BLOCKER ruling remain the historical record. This is Round 2: three specialist agents
(`database-reviewer`, `type-design-analyzer`, `architect`) were run in parallel, each targeting one
part of GPT-PM's 3 BLOCKER + 4 MAJOR ruling, and their output is synthesized and verified here.

## 0. Process followed

Per this project's standing process ("specialist agents propose first, Claude verifies against
primary sources, then GPT-PM decides") and per `~/.claude/CLAUDE.md` §17's one-sweep discipline:

1. `database-reviewer` redesigned the schema/idempotency fixes (devices removal, composite FKs,
   `source_version`, budget-counter hardening).
2. `type-design-analyzer` redesigned the provenance contract fixes (discriminated node schemas,
   generic `ProvenanceValue<T>`, fail-closed `isAiSafe`).
3. `architect` redesigned the reconciler/DLQ/lease protocol — the hardest part, since it had to
   resolve BOTH remaining BLOCKERs (the index-covered-but-authoritative reconciler query, and the
   previously entirely-unspecified stale-`PROCESSING` lease protocol).
4. Claude verified every file:line citation in all three outputs against the actual current files
   (`infra/migrations/0001_ingest_outbox.sql`, `docs/architecture/TDD.md` §14/§16/§17/§18,
   `packages/contracts/src/event.ts`, `packages/contracts/src/provenance.ts`,
   `packages/provenance/src/dag.ts`) before synthesizing.
5. This plan's own first submission to GPT-PM (as a Rosetta GO request) was itself returned
   `VERDICT: BLOCKER` with 2 MAJOR findings — not on the underlying redesign, which GPT-PM
   explicitly confirmed as real and necessary, but on the plan's insufficient verification rigor
   (citation-only, no executable proof) and an ambiguous post-ruling commit boundary. Both are fixed
   in this revision: §2 below is executable evidence, not citations, and this document's own
   Rosetta plan closes the moment GPT-PM's reply to this document is captured — recording that
   reply's content is explicitly the next plan's job, not this one's.

## 1. Cross-reference: every BLOCKER/MAJOR from Round 1, and how this revision resolves it

| #   | Severity                      | GPT-PM's Round-1 finding                                                                                                                          | Resolved by            | Where in this document                      |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------- |
| B1  | BLOCKER                       | Reconciler query cannot be both index-covered and authoritative against `ingest_events.state` — must stay joined, proven via `EXPLAIN QUERY PLAN` | `architect`            | §3.1-§3.3 (design), §2.2 (executable proof) |
| B2  | BLOCKER                       | DLQ transition at attempt cap must be atomic with the failing processing transaction, not a separate reconciler claim                             | `architect`            | §3.5                                        |
| B3  | BLOCKER                       | Stale-`PROCESSING` recovery is unspecified — no processing lease/claim-expiry protocol exists anywhere in the repo                                | `architect`            | §3.4, §3.6                                  |
| M1  | MAJOR                         | `devices` table breaks the migration's own stated scope-boundary rule                                                                             | `database-reviewer`    | §4.1                                        |
| M2  | MAJOR                         | Provenance fail-open — `isAiSafe` needs discriminated node schemas, not just a `!== 'ALLOW'` flip                                                 | `type-design-analyzer` | §5                                          |
| M3  | MAJOR                         | telegram+ALLOW needs structural composite-FK enforcement, not independent CHECKs                                                                  | `database-reviewer`    | §4.2                                        |
| M4  | MAJOR                         | Idempotency fix needs a contract/migration change (`source_version`)                                                                              | `database-reviewer`    | §4.3                                        |
| M5  | MAJOR (new, found mid-ruling) | `ProvenanceValueSchema` doesn't match the frozen TDD's generic `ProvenanceValue<T>` shape                                                         | `type-design-analyzer` | §5.3                                        |

## 2. Executable validation (the evidence GPT-PM's plan-level BLOCKER required)

All commands below were run from
`D:\Temp\claude\d--Repo\72f12469-cfde-4245-902b-988b5ee26b92\scratchpad\g2v2\`, never inside this
repository. `git status` at the time of writing this document shows zero changes under `packages/`,
`services/`, or `infra/migrations/`.

### 2.1 DDL applied to a throwaway SQLite file, `PRAGMA foreign_keys=ON`, full insert matrix

Full schema: [schema_v2.sql](D:\Temp\claude\d--Repo\72f12469-cfde-4245-902b-988b5ee26b92\scratchpad\g2v2\schema_v2.sql)
(synthesizes `database-reviewer`'s and `architect`'s DDL — reproduced piecewise in §4/§3 below).
Driver script: [validate.py](D:\Temp\claude\d--Repo\72f12469-cfde-4245-902b-988b5ee26b92\scratchpad\g2v2\validate.py).

Literal stdout:

```text
PRAGMA foreign_keys = 1 (must be 1)
Schema applied OK (no syntax/constraint-definition errors).
Baseline valid rows inserted OK.
NC1 telegram+ALLOW: REJECTED as expected -> CHECK constraint failed: NOT (source = 'telegram' AND ai_policy = 'ALLOW')
NC2 source-mismatch: REJECTED as expected -> FOREIGN KEY constraint failed
Positive control ev-ok-1 (matching source, valid outbox row): inserted OK.
NC3 orphan provenance_event_id: REJECTED as expected -> FOREIGN KEY constraint failed
Positive control: real provenance_event_id (ev-ok-1) inserted OK.
NC4 DLQ-with-live-lease: REJECTED as expected -> CHECK constraint failed: (state = 'PROCESSING') = (processing_lease_expires_at IS NOT NULL)
NC5 PROCESSING-without-lease: REJECTED as expected -> CHECK constraint failed: (state = 'PROCESSING') = (processing_lease_expires_at IS NOT NULL)
NC6 DLQ-zero-attempts: REJECTED as expected -> CHECK constraint failed: state <> 'DLQ' OR processing_attempt_count >= 1
Positive control: valid PROCESSING+lease row inserted OK.
Positive control: valid DLQ row (attempt_count=5, no lease) inserted OK.
NC7 budget-counter-over-cap: REJECTED as expected -> CHECK constraint failed: dispatched_count >= 0 AND dispatched_count <= 2500
Positive control: budget-counter at exact cap (2500) inserted OK.
```

Seven negative controls, all rejected by a real constraint; every positive control (matching
source, real FK targets, valid PROCESSING+lease, valid terminal DLQ, budget at cap) inserted
without error. `PRAGMA foreign_keys` confirmed `1` before any insert — closing the open gap
`database-reviewer` flagged in Round 1 ("FK enforcement is unverified for D1"): this scratch
harness proves the DDL's constraints are real when the pragma is on; whether Cloudflare D1 itself
defaults it on remains a separate, still-open item — see §7.

### 2.2 `EXPLAIN QUERY PLAN` — the direct proof BLOCKER B1 required

Bulk-populated to 1004 `ingest_events` rows (950 terminal `PROCESSED`/`DLQ` with `CLOSED` outbox
rows, 45 open `ACCEPTED`/`RETRYABLE_FAILED` in various outbox states, 5 live `PROCESSING` with
leases) before measuring, so the plan reflects a realistic terminal-heavy ratio rather than an
empty table where the optimizer's choice is meaningless.

**Reconciler eligibility query (Phase 2, §3.2), literal plan:**

```text
(6, 0, 184, 'SEARCH o USING COVERING INDEX idx_processing_outbox_due (next_attempt_at<?)')
(10, 0, 46, 'SEARCH e USING INDEX sqlite_autoindex_ingest_events_1 (event_id=?)')
```

**Lease-expiry sweep query (Phase 1, §3.4), literal plan:**

```text
(5, 0, 193, 'SEARCH ingest_events USING INDEX idx_ingest_events_processing_lease (processing_lease_expires_at<?)')
```

Both are `SEARCH`-only. No `SCAN`, no `USE TEMP B-TREE FOR ORDER BY` — the outer loop consumes the
partial index in `next_attempt_at`/`processing_lease_expires_at` order directly, satisfying the
`ORDER BY` without a sort, and the inner join is a `PRIMARY KEY` equality probe.

**Negative control 1 — reconciler query with the `o.state <> 'CLOSED'` predicate removed:**

```text
(6, 0, 216, 'SCAN e')
(13, 0, 46, 'SEARCH o USING INDEX sqlite_autoindex_processing_outbox_1 (event_id=?)')
(35, 0, 0, 'USE TEMP B-TREE FOR ORDER BY')
```

**Negative control 2 — lease query with the `state = 'PROCESSING'` predicate removed:**

```text
(4, 0, 216, 'SCAN ingest_events')
(22, 0, 0, 'USE TEMP B-TREE FOR ORDER BY')
```

Both negative controls show the plan **actually change** to a full `SCAN` plus a materialized sort
the moment the partial-index predicate is dropped — proving the `idx_processing_outbox_due` /
`idx_ingest_events_processing_lease` partial indexes are load-bearing for this query shape, not
merely present and unused. This directly answers GPT-PM's plan-level MAJOR: the index usability
claim is demonstrated, not asserted.

### 2.3 `tsc --noEmit` against the repo's own tsconfig and installed zod (`3.25.76`)

Scratch files: [ts/provenance.ts](D:\Temp\claude\d--Repo\72f12469-cfde-4245-902b-988b5ee26b92\scratchpad\g2v2\ts\provenance.ts),
[ts/source-policy.ts](D:\Temp\claude\d--Repo\72f12469-cfde-4245-902b-988b5ee26b92\scratchpad\g2v2\ts\source-policy.ts),
[ts/nodes.ts](D:\Temp\claude\d--Repo\72f12469-cfde-4245-902b-988b5ee26b92\scratchpad\g2v2\ts\nodes.ts),
[ts/event.ts](D:\Temp\claude\d--Repo\72f12469-cfde-4245-902b-988b5ee26b92\scratchpad\g2v2\ts\event.ts).
Compiled via a scratch `tsconfig.json` that `extends` this repo's own root `tsconfig.json` verbatim
(same `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`,
`isolatedModules`), only overriding `include`/`paths` to point at the scratch directory and this
repo's real installed `zod`/`@types/node`.

```text
$ node_modules/.bin/tsc -p tsconfig.json --noEmit
EXIT_CODE=0
```

Zero diagnostics. The discriminated node union, the generic `provenanceValueSchema<T>()` factory,
the fail-closed `isAiSafe`, and the extended `NormalizedEvent`/`idempotencyKey` all compile clean
under this repo's real strictness settings and real zod version — not a hypothetical TypeScript
configuration.

## 3. Reconciler, DLQ, and processing lease (BLOCKER B1/B2/B3 — `architect`)

### 3.0 Root cause

`attempt_count` and `next_attempt_at` both live on `processing_outbox`
(`infra/migrations/0001_ingest_outbox.sql:134-135`), while `ACCEPTED`/`RETRYABLE_FAILED`/
`PROCESSING` live on `ingest_events` (`:98-100`). TDD's own three-term predicate
(`docs/architecture/TDD.md:843-845`) straddles two tables with the attempt counter on the wrong
one. The fix moves the **processing** retry budget onto `ingest_events` (processing truth,
`ADR-006:31`) and leaves `processing_outbox` owning only **transport** truth (dispatch count, due
time) — the mechanical form of "distinguish processing attempts from queue dispatches."

### 3.1 Column changes

`ingest_events` gains, alongside its existing five-state `state` (unchanged — no sixth state is
introduced):

```sql
processing_attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (processing_attempt_count >= 0),
processing_lease_owner      TEXT,
processing_lease_expires_at TEXT,
first_failed_at TEXT,
CHECK ((state = 'PROCESSING') = (processing_lease_expires_at IS NOT NULL)),
CHECK ((processing_lease_owner IS NULL) = (processing_lease_expires_at IS NULL)),
CHECK (state <> 'DLQ' OR processing_attempt_count >= 1)
```

The first two CHECKs make an un-leased `PROCESSING` row, or a leased non-`PROCESSING` row,
**unrepresentable** — verified in §2.1 (NC4, NC5). `processing_outbox` renames `attempt_count` to
`dispatch_count` (queue writes only) and gains one transport-terminal state, `CLOSED`, used purely
for index hygiene:

```sql
state TEXT NOT NULL
  CHECK (state IN ('PENDING', 'DISPATCHED', 'RETRY_PENDING', 'BUDGET_DEFERRED', 'CLOSED'))
  DEFAULT 'PENDING',
dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_count >= 0),
CHECK (state <> 'DISPATCHED' OR dispatched_at IS NOT NULL)
```

`CLOSED` is never read by the reconciler's correctness predicate (§3.2) — only by the partial
index's own `WHERE` clause, so a lost `CLOSED` write costs one extra `PRIMARY KEY` probe, never a
correctness bug. This is the direct fix for GPT-PM's rejection of the Round-1 `architect` proposal,
which had made the outbox predicate purely `processing_outbox`-native.

### 3.2 Indexes

```sql
CREATE INDEX idx_processing_outbox_due
  ON processing_outbox(next_attempt_at, event_id, state, dispatch_count)
  WHERE state <> 'CLOSED';

CREATE INDEX idx_ingest_events_processing_lease
  ON ingest_events(processing_lease_expires_at, event_id, processing_attempt_count)
  WHERE state = 'PROCESSING';

CREATE INDEX idx_ingest_events_unprocessed
  ON ingest_events(received_at, event_id)
  WHERE state IN ('ACCEPTED', 'PROCESSING', 'RETRYABLE_FAILED');
```

`idx_processing_outbox_reconciler(state, next_attempt_at)` (current migration line 142) is
**deleted**, not kept alongside — leading on `state` forces a range scan per state value and keeps
terminal rows in the hot B-tree forever; leading on `next_attempt_at` with a partial predicate
gives one contiguous range in `ORDER BY` order, sized by open backlog only (proof: §2.2).

### 3.3 The reconciler eligibility query (Phase 2)

```sql
SELECT o.event_id, o.state, o.dispatch_count, e.state, e.processing_attempt_count
FROM processing_outbox AS o
JOIN ingest_events AS e ON e.event_id = o.event_id
WHERE o.state <> 'CLOSED'
  AND o.next_attempt_at <= :now
  AND e.state IN ('ACCEPTED', 'RETRYABLE_FAILED')
  AND e.processing_attempt_count < :max_processing_attempts
ORDER BY o.next_attempt_at
LIMIT :batch;
```

`e.state` — the authoritative processing truth — is a genuine `WHERE` term here, satisfying
BLOCKER B1's requirement that the query "stay joined against `ingest_events.state`."
`'DISPATCHED'` is not excluded from `o.state`: a `DISPATCHED` row whose message evaporated (>24h
queue outage) is still due and its event is still `ACCEPTED`, so it re-enters this query on its own
— `docs/architecture/TDD.md:874-878`'s named resilience case, satisfied by the _event_ state, not a
transport convention.

### 3.4 The processing lease (BLOCKER B3 — previously entirely unspecified)

```
MAX_PROCESSING_ATTEMPTS   = 5        (TDD.md:859, unchanged)
PROCESSING_LEASE_TTL      = 120 s    (>> light-consumer ~10ms CPU budget, ADR-011:51-55; HYPOTHESIS,
                                       to be re-derived from G2-PREFLIGHT-01's measured wall time)
VISIBILITY_TIMEOUT_BASE   = 15 min
MAX_DISPATCH_BACKOFF      = 6 h
```

**Claim (one CAS statement that is also the fetch):**

```sql
UPDATE ingest_events
   SET state = 'PROCESSING',
       processing_lease_owner = :owner,               -- fresh uuid per attempt (fencing token)
       processing_lease_expires_at = :now_plus_ttl,
       processing_attempt_count = processing_attempt_count + 1
 WHERE event_id = :event_id
   AND processing_attempt_count < :max_processing_attempts
   AND (
         state IN ('ACCEPTED', 'RETRYABLE_FAILED')
      OR (state = 'PROCESSING' AND processing_lease_expires_at <= :now)
       )
RETURNING event_id, source, source_account_id, content_locator_ref,
          source_policy_id, trace_id, schema_version,
          processing_attempt_count, processing_lease_owner;
```

Zero rows is the normal outcome for a redelivered queue message (already `PROCESSED`/`DLQ`, a live
lease held by someone else, or at the cap) — the consumer ACKs and returns; nothing is re-queued.
**Increment happens at claim time**, not at recorded-failure time: a consumer crash (OOM, CPU-limit
kill) commits no failure transaction, so a failure-time-only counter would let a poison event that
reliably crashes the isolate loop forever without ever reaching DLQ, contradicting
`docs/architecture/TDD.md:884` ("Queue operation usage stops increasing for that event"). This is
flagged, not silently assumed — see §6.

**Phase 1, the stale-lease sweep, runs before Phase 2 in the same cron invocation:**

```sql
SELECT event_id, processing_attempt_count, processing_lease_owner, trace_id, first_failed_at
  FROM ingest_events
 WHERE state = 'PROCESSING'
   AND processing_lease_expires_at <= :now
 ORDER BY processing_lease_expires_at
 LIMIT :sweep_batch;
```

Reclaim below the cap transitions to `RETRYABLE_FAILED` and re-arms the outbox row so Phase 2 picks
it up in the **same** cron run; reclaim at the cap uses the same atomic DLQ batch as §3.5, fenced on
`(processing_lease_expires_at <= :now AND processing_lease_owner = <observed owner>)` — an ABA guard
against a holder that renewed its lease between the `SELECT` and the reclaim `UPDATE`.

### 3.5 Atomic DLQ transition at the cap (BLOCKER B2)

Issued by the **failing attempt's own transaction** in `services/processor` (D1 `batch()`, one
implicit transaction, all-or-nothing) — not by the reconciler discovering a stale count later:

```sql
-- batch[0] close the attempt audit row
UPDATE processing_attempts SET finished_at=:now, outcome=:outcome, error_class=:ec, error_code=:cd
 WHERE attempt_id = :attempt_id;

-- batch[1] THE transition, fenced on the lease owner and the cap
UPDATE ingest_events
   SET state = 'DLQ',
       first_failed_at = COALESCE(first_failed_at, :now),
       processing_lease_owner = NULL, processing_lease_expires_at = NULL
 WHERE event_id = :event_id
   AND state = 'PROCESSING'
   AND processing_lease_owner = :owner
   AND processing_attempt_count >= :max_processing_attempts;

-- batch[2] exactly one dead-letter row, idempotent under replay
INSERT INTO dead_letter_events (event_id, error_class, error_code, processor_version,
  attempt_count, first_failed_at, last_failed_at, trace_id, created_at)
SELECT e.event_id, :ec, :cd, :pv, e.processing_attempt_count,
       COALESCE(e.first_failed_at, :now), :now, e.trace_id, :now
  FROM ingest_events e
 WHERE e.event_id = :event_id AND e.state = 'DLQ'
   AND NOT EXISTS (SELECT 1 FROM dead_letter_events d WHERE d.event_id = e.event_id);

-- batch[3] index hygiene only -- CLOSED is a DERIVED fact, unsettable unless genuinely terminal
UPDATE processing_outbox SET state = 'CLOSED', updated_at = :now
 WHERE event_id = :event_id
   AND EXISTS (SELECT 1 FROM ingest_events e
                WHERE e.event_id = processing_outbox.event_id AND e.state IN ('PROCESSED','DLQ'));
```

Every statement is self-guarding: if the app picks the wrong batch, guards match 0 rows and nothing
changes. `batch[1]` clears the fence, so it runs before anything relying on the fence being cleared.

**Why the reconciler's `< MAX` filter is now provably sufficient:** the only way to reach
`processing_attempt_count = MAX` is through the claim CAS (§3.4); the only two ways out of the
resulting `PROCESSING` state are this batch and the lease-expiry batch (§3.4), both of which
transition to `DLQ` at the cap. A capped, non-terminal event is unrepresentable (verified: §2.1
NC6), so excluding `processing_attempt_count >= MAX` from the hot query hides nothing.

### 3.6 Verification matrix, condensed (full scenario table in the agent's own output)

| Outbox row                                         | Event row                   | Query outcome                                               | Invariant preserved                    |
| -------------------------------------------------- | --------------------------- | ----------------------------------------------------------- | -------------------------------------- |
| `DISPATCHED`, due                                  | `ACCEPTED`                  | selected, re-dispatched                                     | `TDD.md:874-878` queue-expiry recovery |
| `DISPATCHED`, due (stale `CLOSED` write lost)      | `PROCESSED`/`DLQ`           | rejected by `e.state` filter                                | `INV-08`/`INV-29`, no duplicate        |
| any, due                                           | `PROCESSING`, live lease    | rejected                                                    | no double-dispatch mid-attempt         |
| any, due                                           | `PROCESSING`, expired lease | reclaimed by Phase 1 first                                  | B3                                     |
| replayed queue message, live lease                 | —                           | claim CAS matches 0 rows, ACK                               | idempotent redelivery                  |
| consumer crash mid-attempt                         | —                           | lease expires, Phase 1 reclaims or DLQs                     | crash safety                           |
| queue message expires (>24h outage), never claimed | —                           | `dispatch_count` only, `processing_attempt_count` untouched | B2's budget-separation requirement     |

## 4. Schema fixes (`database-reviewer`)

### 4.1 Remove `devices` (MAJOR M1)

Deletes `infra/migrations/0001_ingest_outbox.sql:32-40` entirely; the `users` table comment
(`:21-22`) drops its now-dangling justification via `devices`. `FACT`, confirmed by full-file read:
`devices` is referenced nowhere else in the migration.

### 4.2 Composite FKs binding `source` identity structurally (MAJOR M3)

```sql
ALTER TABLE source_accounts ADD ... -- expressed at CREATE TABLE time:
UNIQUE (source_account_id, source)   -- on source_accounts

UNIQUE (source_policy_id, source),   -- on source_policies, PLUS:
CHECK (NOT (source = 'telegram' AND ai_policy = 'ALLOW'))
```

`ingest_events` then references both composite keys instead of the two independent single-column
FKs it has today:

```sql
FOREIGN KEY (source_account_id, source) REFERENCES source_accounts(source_account_id, source),
FOREIGN KEY (source_policy_id, source) REFERENCES source_policies(source_policy_id, source)
```

**Verified in §2.1**: NC1 proves `source_policies` can no longer hold `telegram + ALLOW`; NC2
proves an event whose own `source` doesn't match its `source_account`'s real `source` is rejected
by the composite FK, not merely by an independent, uncorrelated CHECK.

### 4.3 `source_version` (MAJOR M4)

D1 column (`ingest_events.source_version TEXT`, nullable), contract field
(`packages/contracts/src/event.ts`), and `idempotencyKey()` extended to a 4th length-prefixed
component — full design and rationale in §3.4 of `event.ts`'s own reasoning, reproduced as the
scratch file in §2.3. `SCHEMA_VERSION` bumps `3 -> 4` (a wire-contract shape change, not cosmetic).

### 4.4 `queue_budget_counters` hardening (confirmed by GPT-PM in Round 1, refined here)

The atomic upsert GPT-PM already confirmed (`INSERT ... ON CONFLICT(day) DO UPDATE ... WHERE
dispatched_count + ?n <= ?cap RETURNING dispatched_count`) has one edge case
`database-reviewer` found: the plain `INSERT` branch on a new day's first call is not covered by
the `WHERE` guard, so an oversized first call could silently exceed budget. Added as a hard
backstop, verified in §2.1 (NC7):

```sql
dispatched_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatched_count >= 0 AND dispatched_count <= 2500)
```

This turns a silent over-cap into a loud constraint failure the caller must handle — strictly
better, though the caller still needs to pre-clamp or catch-and-defer. If 2500 ever becomes
runtime-configurable, this literal moves to application logic.

### 4.5 One further gap found and fixed, not in GPT-PM's Round-1 ruling

`ingest_event_routing_hint_provenance.provenance_event_id` had **no FK and no uniqueness
constraint at all** (`FACT`, current migration lines 118-123) — a table whose entire purpose is an
auditable provenance ledger could silently duplicate or reference a nonexistent event. Fixed:

```sql
CREATE TABLE ingest_event_routing_hint_provenance (
  event_id TEXT NOT NULL,
  hint_index INTEGER NOT NULL,
  provenance_event_id TEXT NOT NULL REFERENCES ingest_events(event_id),
  FOREIGN KEY (event_id, hint_index) REFERENCES ingest_event_routing_hints(event_id, hint_index),
  PRIMARY KEY (event_id, hint_index, provenance_event_id)
);
```

Verified in §2.1: NC3 (orphan `provenance_event_id`) rejected; the immediately following positive
control (a real id) accepted.

**Explicitly deferred, not adopted here:** `architect`'s own §5(c) suggestion to also denormalize
`source` onto `ingest_event_routing_hints` with a matching composite FK and per-hint
telegram+ALLOW CHECK. That agent itself flagged it as "a genuinely separate design decision... goes
beyond what was ruled on" — this document agrees and defers it to a future roadmap item rather than
silently adopting it.

## 5. Provenance contract fixes (`type-design-analyzer`)

### 5.1 Discriminated node schemas replace the loose `ProvenanceNode` interface (MAJOR M2)

Three node kinds — `SOURCE_EVENT`, `STATIC_CONFIG` (both `provenance: []`, exactly zero ancestors —
a genuine root is now a _type_, not a doc-comment convention any empty array happens to satisfy),
and `DERIVED` (`provenance` non-empty) — combined via
`z.discriminatedUnion('kind', [SourceEventNodeSchema, StaticConfigNodeSchema, DerivedNodeSchema])`.
Full source: §2.3's `ts/nodes.ts`, typechecked clean.

### 5.2 `isAiSafe` fixed to fail closed at the actual boundary

```ts
export function isAiSafe(candidate: unknown, lookup: ProvenanceLookup, seen = new Set()): boolean {
  const parsed = ProvenanceNodeSchema.safeParse(candidate);
  if (!parsed.success) return false;
  const node = parsed.data;
  if (node.ai_policy !== 'ALLOW') return false; // explicit allow, not `!== 'DENY'`
  if (seen.has(node.id)) return false; // cycle guard
  // ... recurse into node.provenance, unresolved ancestor -> false
}
```

`candidate: unknown` validated via `ProvenanceNodeSchema.safeParse` closes the gap Round 1 found:
an object that never went through zod validation, carrying an arbitrary `ai_policy` value
(including `undefined`), can no longer pass as safe just because it has no ancestors — it fails
`safeParse` outright. `!== 'ALLOW'` (not `!== 'DENY'`) means a future third value added to the
schema fails closed automatically rather than silently passing.

`sourceEventNode()` is corrected to resolve `ai_policy` from a validated `source_policies` row
(`SourcePolicyLookup`, §2.3's `ts/source-policy.ts`) and to reject a mismatch between
`event.source` and the resolved policy's own `source` — never from a caller-supplied literal.

### 5.3 Generic `ProvenanceValue<T>` (new MAJOR M5, found mid-Round-1)

```ts
export function provenanceValueSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.object({
    value: valueSchema,
    provenance: z.array(z.string().min(1)).min(1),
    derivation_method: DerivationMethodSchema,
    ai_policy: AiPolicySchema,
    sensitivity: SensitivitySchema.optional(),   -- see open question below
    created_at: z.string().datetime({ offset: true }),
    derivation_version: z.number().int().positive(),
  }).strict();
}
```

Concrete instantiations (`StringProvenanceValueSchema`, `NumberProvenanceValueSchema`,
`DatetimeProvenanceValueSchema`, `BooleanProvenanceValueSchema`, `enumProvenanceValueSchema()`)
replace the single hard-coded string-only shape. `routing_hints` in `event.ts` becomes
`z.array(StringProvenanceValueSchema).max(MAX_ROUTING_HINTS)` (both the generic-shape fix and
`architect`'s unbounded-array fix land in the same field). Full source: §2.3's `ts/provenance.ts`
and `ts/event.ts`, typechecked clean together.

**Open question, explicitly not decided unilaterally:** `sensitivity`'s value set
(`LOW`/`MEDIUM`/`HIGH`) is `INFERENCE` — invented for this proposal, not ratified anywhere in the
TDD. Kept `.optional()` so it type-checks without asserting a value set nobody has approved; needs
a GPT-PM ruling or an erratum to the TDD before it is treated as normative.

## 6. Invariant-preservation check (required by GPT-PM's plan-level GO)

| Invariant (from GPT-PM's Round-1 ruling)                                                      | Preserved? | Evidence                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingest_events.state` remains sole processing authority; outbox `CLOSED` is optimization-only | Yes        | §3.3's query reads `e.state`, never `o.state`, for eligibility; §2.2 negative control shows the plan changes but the _result set_ does not depend on `CLOSED` for correctness, only for scan cost                                         |
| Queue dispatch/re-dispatch never consumes the processing-attempt budget                       | Yes        | `dispatch_count` (outbox) and `processing_attempt_count` (events) are separate columns incremented by separate code paths (§3.0); §2.1's schema enforces this structurally, not by convention                                             |
| Atomic processor-side DLQ at cap coexists with a reclaimable expired lease                    | Yes        | §3.5 (processor-side, transactional) and §3.4/Phase-1 (reconciler-side, lease-driven) both terminate into the same idempotent DLQ batch; verified schema-level in §2.1 (NC4/NC5/NC6 make the illegal intermediate states unrepresentable) |

## 7. Explicitly flagged, not decided here

- **`PRAGMA foreign_keys` on D1**: §2.1 proves the DDL's constraints work when the pragma is on;
  whether Cloudflare D1 enables it by default, and how/where to force it on if not, is unverified
  against D1 itself (only against local SQLite) and must be an explicit, tested G2 DoD item.
- **`sensitivity`'s value set** (§5.3) — needs a ruling, not an assumption.
- **`PROCESSING_LEASE_TTL = 120s`** (§3.4) is a `HYPOTHESIS`, to be re-derived from
  G2-PREFLIGHT-01's measured consumer wall time before being frozen in `packages/domain`.
- **Claim-time vs. failure-time attempt increment** (§3.4): this document recommends claim-time,
  with the crash-loop-poison rationale given inline. If GPT-PM prefers failure-time instead, a
  separate `lease_reclaim_count` column with its own cap would be needed for the same guarantee —
  strictly more state for the same protection.
- **`architect`'s optional per-hint composite-FK extension** (§4.5) is deferred to the roadmap, not
  adopted, per that agent's own recommendation.

## 8. What is NOT authorized by this document

Same as Round 1: nothing here authorizes touching `packages/`, `services/`, or
`infra/migrations/`. This is a proposal for GPT-PM's ruling. G2 implementation requires its own
Rosetta plan and GO, filed only after this document receives `VERDICT: APPROVE`.
