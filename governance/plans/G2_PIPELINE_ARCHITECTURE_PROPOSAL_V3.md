# G2 pipeline architecture — Revision 3 (PROPOSAL / PENDING GPT-PM / NON-NORMATIVE)

**Status of this document: a proposal awaiting GPT-PM's ruling, not a settled decision.** Nothing
in this file authorizes G2 implementation. No file under `packages/`, `services/`, or
`infra/migrations/` has been created or modified. Every SQL/TypeScript snippet below was executed
against the same throwaway scratch harness as V2 (`D:\Temp\claude\d--Repo\72f12469-cfde-4245-902b-988b5ee26b92\scratchpad\g2v2\`),
extended for Round 3. Actual stdout/exit codes are pasted in as evidence, not paraphrased.

Scope, per GPT-PM's own closing instruction on Round 2 ("Keep the next revision limited to these
four findings and their direct regression tests"): this document addresses exactly the 2 BLOCKER +
2 MAJOR findings from GPT-PM's ruling on `G2_PIPELINE_ARCHITECTURE_PROPOSAL_V2.md`
(`replyId 32da2144-9a34-4326-b388-06bfc30fc3ce`). It does not re-litigate any of the 3 BLOCKERs or 3
MAJORs GPT-PM confirmed closed in that same round.

## 1. Cross-reference: Round 2's 4 open findings, and how this revision resolves them

| # | Severity | GPT-PM's Round-2 finding | Where resolved |
|---|---|---|---|
| B2/B3 | BLOCKER | Processor outcome state machine incomplete — a `PERMANENT_FAILURE` below the attempt cap was left `PROCESSING`, then incorrectly retried after lease expiry | §2 |
| lease-ABA | BLOCKER | `processing_lease_owner` (a reusable identity) was the fencing value, not a fresh per-claim token — a stale claimant could pass the fence | §3 |
| M4 | MAJOR | `source_version` nullable with no stated mandatory condition — the original `MESSAGE_UPDATED` collision still possible | §4 |
| M5 | MAJOR | Durable `ingest_event_routing_hints` never gained `sensitivity`/`created_at`/`derivation_version`; `provenance.min(1)` inconsistent with `STATIC_CONFIG`'s own zero-ancestor root | §5 |

**Two amendments made after GPT-PM's plan-level review of this round's own Rosetta plan** (which
returned `VERDICT: BLOCKER`, 0 BLOCKER/2 MAJOR on the plan's stated scope, not the design):

- `sensitivity` is a **required**, non-empty opaque string end-to-end (contract and durable table)
  — not left optional, and not given an invented `LOW`/`MEDIUM`/`HIGH` vocabulary, per GPT-PM's own
  instruction: "do not invent LOW/MEDIUM/HIGH as binding; a non-empty opaque/validated string ... is
  acceptable pending a later vocabulary decision."
- An explicit ABA regression sequence is executed and its literal row-count evidence included in
  §3.3 below, per GPT-PM's own specified sequence.

## 2. Complete fenced processor transition protocol (BLOCKER B2/B3)

V2's §3.5 only transitioned to `DLQ` when `processing_attempt_count >= MAX`. A `PERMANENT_FAILURE`
on an earlier attempt had no transition at all, so it stayed `PROCESSING` until lease expiry, at
which point the below-cap reclaim path incorrectly turned it into `RETRYABLE_FAILED` and retried
it — contradicting the TDD's requirement that a permanent failure is terminal.

**Fixed: four distinct, fenced D1 batches, chosen by the actual outcome + attempt count, not by
attempt count alone:**

- **SUCCESS** → `PROCESSED`, lease cleared, outbox `CLOSED`.
- **Retryable failure, `count < MAX`** → `RETRYABLE_FAILED`, lease cleared, `first_failed_at` set,
  outbox re-armed `RETRY_PENDING`.
- **Retryable failure at `count >= MAX`, OR permanent failure at ANY count** → `DLQ` (single atomic
  batch, unchanged shape from V2's §3.5 except its guard condition):

```sql
UPDATE ingest_events
   SET state = 'DLQ',
       first_failed_at = COALESCE(first_failed_at, :now),
       processing_lease_owner = NULL, processing_lease_token = NULL, processing_lease_expires_at = NULL
 WHERE event_id = :event_id
   AND state = 'PROCESSING'
   AND processing_lease_token = :token
   AND (:outcome = 'PERMANENT_FAILURE' OR processing_attempt_count >= :max_processing_attempts);
```

`:outcome = 'PERMANENT_FAILURE'` now bypasses the attempt-count check entirely — a permanent
failure is terminal on its FIRST occurrence, at any attempt count. The application dispatcher picks
exactly one of the four batches based on the outcome it just classified and the attempt count
returned by the original claim; no batch's guard overlaps another's.

**Executed evidence (all four scenarios, scratch DB):**

```text
Scenario A (PERMANENT_FAILURE @ attempt 1, count<MAX): affected=1, resulting state=('DLQ', 1) -- must be DLQ, not left PROCESSING
Scenario B, DLQ predicate correctly did NOT match retryable-below-cap: affected=0 (must be 0)
Scenario B, RETRYABLE_FAILED transition: affected=1, resulting state=('RETRYABLE_FAILED',) -- must be RETRYABLE_FAILED
Scenario C (RETRYABLE_FAILURE @ cap): affected=1, resulting state=('DLQ',) -- must be DLQ
Scenario D (SUCCESS): affected=1, resulting state=('PROCESSED',) -- must be PROCESSED
Capped non-terminal rows remaining after all transitions: [] -- must be empty list
```

The last line is the **transition invariant** GPT-PM asked for in place of V2's overstated
"unrepresentable" claim (see §6) — proven empirically across all four scenarios together, not
asserted from the schema alone.

## 3. Fresh per-claim lease token as the actual fencing value (BLOCKER, lease ABA)

V2 fenced every mutation on `processing_lease_owner` — a worker/instance identity that can be
reused across claims. GPT-PM's finding: "If it is a reusable worker/instance identity, claim A can
expire, claim B can reuse the same owner, and a stale claimant can pass an owner fence."

### 3.1 Schema change

```sql
processing_lease_owner TEXT,   -- kept for observability only, NEVER used as a fence
processing_lease_token TEXT,   -- fresh UUID per claim; THE fencing value
CHECK ((processing_lease_token IS NULL) = (processing_lease_expires_at IS NULL)),
CHECK ((processing_lease_owner IS NULL) = (processing_lease_expires_at IS NULL))
```

### 3.2 Every claim, transition, and reclaim now predicates on `processing_lease_token`

The claim CAS (unchanged from V2 otherwise) issues a fresh `:token` (UUID) on every successful
claim, including a reclaim of an expired lease — this is what makes the token, not the owner, the
actual single-use fencing value. Every transition batch in §2 fences on
`processing_lease_token = :token` (the exact token the claiming attempt was handed), never on
`processing_lease_owner`.

### 3.3 The exact ABA regression sequence GPT-PM required, executed

```text
Reclaim (expired token-A -> fresh token-B): affected=1 (must be 1)
Stale mutation from original holder (token-A, now superseded): affected=0 (must be 0 -- THE ABA guard)
Fresh mutation from reclaiming holder (token-B): affected=1 (must be 1), resulting state=('PROCESSED',)
```

Concretely: `ev-aba` was claimed with `token-A`, its lease allowed to expire, then reclaimed by
Phase 1 into `token-B` (`UPDATE ... SET processing_lease_token='token-B' ... WHERE
processing_lease_token='token-A' AND processing_lease_expires_at <= :now`). A mutation attempt
still carrying `token-A` — from the SAME worker identity (`worker-X`) that originally held the
lease — affects **zero rows**, because the token, not the owner, is now stale. Only the mutation
carrying the current `token-B` succeeds. This is the precise ABA scenario named in Round 2: same
identity, superseded credential.

### 3.4 Lease TTL — GPT-PM's second point in this finding

"`PROCESSING_LEASE_TTL=120s` cannot be derived from a CPU-only preflight measurement... define
lease renewal/heartbeat, or require a measured end-to-end wall-time bound." Adopting the
renewal/heartbeat option, since a fixed TTL derived from any single measurement is fragile against
variable real-world latency:

```sql
-- Callable mid-attempt for a genuinely long-running processing step. Fenced identically to every
-- other mutation -- a zombie cannot renew a lease it no longer holds.
UPDATE ingest_events
   SET processing_lease_expires_at = :now_plus_ttl
 WHERE event_id = :event_id AND state = 'PROCESSING' AND processing_lease_token = :token;
```

`PROCESSING_LEASE_TTL` itself stays a conservative starting value (still `HYPOTHESIS`, not
re-derived from the CPU preflight per GPT-PM's correction) with renewal as the actual safety net
against a legitimately slow attempt being reclaimed mid-flight — the initial TTL only needs to be
"long enough to make the first renewal," not "long enough for the whole attempt."

## 4. `source_version` structurally mandatory for `MESSAGE_UPDATED` (MAJOR M4)

**DB (`infra/migrations/0001_ingest_outbox.sql`, proposed):**

```sql
CHECK (event_type <> 'MESSAGE_UPDATED' OR source_version IS NOT NULL)
```

**Contract (`packages/contracts/src/event.ts`, proposed, added to `NormalizedEventSchema`'s
existing `superRefine`):**

```ts
if (event.event_type === 'MESSAGE_UPDATED' && event.source_version === null) {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['source_version'],
    message: 'MESSAGE_UPDATED requires a non-null source_version ...',
  });
}
```

**Executed evidence — all three behavioral proofs GPT-PM required:**

```text
NC8 MESSAGE_UPDATED-no-version: REJECTED as expected -> CHECK constraint failed: event_type <> 'MESSAGE_UPDATED' OR source_version IS NOT NULL
Positive control: MESSAGE_UPDATED with source_version='rev-1' inserted OK.
NC9 same-revision-retry collides on idempotency_key as intended -> UNIQUE constraint failed: ingest_events.idempotency_key
Positive control: a DIFFERENT revision (rev-2, different idempotency_key) inserted OK -- distinct key.
```

Reading these against GPT-PM's three named proofs: (1) *same revision retry → same key* — NC9's
retry of `rev-1` collides on `idempotency_key`, exactly the intended dedup behavior; (2) *two
revisions → different keys* — the `rev-2` positive control inserts as a distinct row; (3)
*required-version update with no version → rejected* — NC8.

## 5. Durable routing-hint metadata + `STATIC_CONFIG` consistency (MAJOR M5)

### 5.1 `sensitivity` required end-to-end (amended per this round's own plan-level review)

**Contract (`packages/contracts/src/provenance.ts`):**

```ts
export const SensitivitySchema = z.string().min(1);   // required, non-empty, opaque -- no
                                                        // invented LOW/MEDIUM/HIGH vocabulary
// inside provenanceValueSchema<T>():
sensitivity: SensitivitySchema,   // NOT .optional()
```

**DB (`ingest_event_routing_hints`):**

```sql
CREATE TABLE ingest_event_routing_hints (
  event_id TEXT NOT NULL REFERENCES ingest_events(event_id),
  hint_index INTEGER NOT NULL,
  value TEXT NOT NULL,
  derivation_method TEXT NOT NULL CHECK (...),
  ai_policy TEXT NOT NULL CHECK (...),
  sensitivity TEXT NOT NULL CHECK (length(trim(sensitivity)) > 0),
  created_at TEXT NOT NULL,
  derivation_version INTEGER NOT NULL CHECK (derivation_version > 0),
  PRIMARY KEY (event_id, hint_index)
);
```

**Executed evidence:**

```text
Positive control: routing hint with a real sensitivity value, created_at + derivation_version present: inserted OK.
NC11 routing-hint-missing-sensitivity: REJECTED as expected -> NOT NULL constraint failed: ingest_event_routing_hints.sensitivity
NC12 routing-hint-empty-string-sensitivity: REJECTED as expected -> CHECK constraint failed: length(trim(sensitivity)) > 0
NC13 routing-hint-missing-created_at: REJECTED as expected -> NOT NULL constraint failed: ingest_event_routing_hints.created_at
```

`sensitivity`'s CLOSED VOCABULARY (what values are actually valid beyond "non-empty") remains an
explicitly open item — see §7 — but its PRESENCE is now structurally mandatory in both layers,
which is what Round 2 required.

### 5.2 `STATIC_CONFIG` zero-ancestor consistency

```ts
export function provenanceValueSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.object({
    value: valueSchema,
    provenance: z.array(z.string().min(1)),   // no longer unconditionally .min(1)
    derivation_method: DerivationMethodSchema,
    ai_policy: AiPolicySchema,
    sensitivity: SensitivitySchema,
    created_at: z.string().datetime({ offset: true }),
    derivation_version: z.number().int().positive(),
  }).strict().superRefine((v, ctx) => {
    if (v.derivation_method !== 'STATIC_CONFIG' && v.provenance.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provenance'],
        message: 'Non-STATIC_CONFIG values must carry at least one provenance id...',
      });
    }
  });
}
```

Only a `STATIC_CONFIG`-derived value may have zero provenance entries — matching
`packages/provenance`'s own `StaticConfigNodeSchema` (`provenance: z.tuple([])`) exactly, rather
than the two schemas disagreeing about what a genuine root looks like.

## 6. Evidence correction (not a new defect — GPT-PM flagged this in Round 2)

V2's §3.6 claimed a capped non-terminal event is "unrepresentable," citing a DDL-only negative
control (DLQ-with-zero-attempts rejected). That control does not prove the actual claim. This
document replaces it with the real evidence: §2's four-scenario matrix, ending in **zero** capped
non-terminal rows remaining across SUCCESS, retryable-below-cap, retryable-at-cap, and
permanent-failure paths executed together — a proven **transition** invariant, not a static schema
claim.

## 7. Explicitly flagged, not decided here (carried forward / updated from V2)

- **`sensitivity`'s closed vocabulary** (if one is ever wanted beyond "non-empty string") needs its
  own ratification — not invented here, per GPT-PM's explicit instruction both rounds.
- **`PRAGMA foreign_keys` on D1**: GPT-PM's Round-2 reply states Cloudflare's current documentation
  confirms D1 enforces foreign keys by default. Treated as GPT-PM's own citation here, not yet
  independently re-verified by Claude against Cloudflare's docs directly — flagged for that
  independent check before being relied on as settled fact in an implementation gate.
- **`PROCESSING_LEASE_TTL`'s starting value** remains a conservative `HYPOTHESIS`; §3.4's renewal
  mechanism is the actual safety net, not the fixed value.
- `architect`'s optional per-hint composite-FK extension (V2 §4.5) remains deferred to the roadmap,
  unchanged from V2.

## 8. What is NOT authorized by this document

Same as V1/V2: nothing here authorizes touching `packages/`, `services/`, or `infra/migrations/`.
G2 implementation requires its own Rosetta plan and GO, filed only after this document receives
`VERDICT: APPROVE`.
