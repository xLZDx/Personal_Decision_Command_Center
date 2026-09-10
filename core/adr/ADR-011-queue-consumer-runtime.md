# ADR-011: Queue Consumer Runtime Choice / Fallback

**Status:** DRAFT (G0 output M) — pending operator/GPT-PM adoption at G0 closure and pending G0
item E (empirical Cloudflare Free-account CPU probe). This ADR directly resolves NB1, the sole
BLOCKER from the v0.2 adversarial review.

**Source:** `docs/architecture/TDD.md` §16.1, §16.2, §65; `governance/reviews/02-tdd-v0.2-adversarial-review.md`
NB1.

## Context

Cloudflare's own documentation is internally ambiguous: the Workers Free limits table states 10ms
active CPU per invocation; the Queues limits page separately describes a 30s default / 5min
configurable consumer CPU limit while also saying consumers "share the same per-invocation CPU
limits as any Worker does." The v0.2 review determined the 30s/5min figure is the **Paid**-plan
behavior, and a Free-plan Queue consumer is bound by the same ~10ms budget as any other Free
Worker invocation — the opposite of what v0.1/v0.2 had assumed, and load-bearing enough (the whole
resolver/scoring step was designed as "heavy work runs in the consumer") to be a BLOCKER, not a
MINOR.

## Decision

**Conservative budget, adopted for MVP1 regardless of which documentation page turns out to be
authoritative:**

```
HTTP Worker target active CPU      <= 8ms p95 in quota harness
Queue consumer target active CPU   <= 8ms p95 in quota harness
Assumed hard design ceiling        10ms active CPU/invocation
initial max_batch_size             1 event
```

The consumer is redesigned as **light, not heavy**: bounded indexed fetch by primary key, fetch
`<= MAX_TOPIC_CANDIDATES` (default 20) via an indexed query, a bounded deterministic score, small
schema validation, a state-transition write, I/O calls to source/AI only where policy permits.
Waiting on D1/Gmail/Workers-AI/network I/O does not count as active CPU; CPU actually spent
parsing/scoring/serializing must be measured and kept in the single-digit-millisecond range. No
unbounded scans, large in-memory corpora, compression, bulk export, or batch semantic processing
in the consumer.

**Pre-approved fallback (ADR, not a new gate needed to invoke it):** if the empirical G0/G2 probe
shows the Worker consumer cannot maintain adequate margin under the 10ms conservative budget, the
queue consumer switches to Cloudflare's documented **HTTP pull consumer** running on the
already-required connector host (same host as the Telegram TDLib connector), moving CPU-heavy
processing outside Workers entirely while keeping the same queue/event contracts.

**Backup execution moved off Workers as a direct consequence:** nightly D1 export/compress/
encrypt/upload-to-R2 runs on the connector host (`host/backup-agent/`), never inside a Worker —
bulk compression/encryption at 10ms CPU is not realistic (see `docs/architecture/TDD.md` §53).

## Live re-verification, 2026-09-10 (G0 item C) — the contradiction got worse, not better

Re-fetching Cloudflare's live docs did not resolve NB1. It is now **three-way** (full quotes and
URLs in `docs/architecture/EXTERNAL_ASSUMPTIONS.md` §C):

1. The Workers limits CPU table has **no Queue-consumer row at all** — only HTTP request (10 ms
   Free) and Cron Trigger (10 ms Free). Queue consumers appear only in the *wall time* table
   (15 minutes, which is not a CPU figure).
2. The Queues limits page still says 30 s default / 5 min configurable, under a blanket "applies
   to both Paid and Free" header.
3. The Workers **pricing** page says "Max of 15 minutes of CPU time per Cron Trigger or Queue
   Consumer invocation" — in the **Paid** column, with the Free column saying only 10 ms and no
   queue exception.

The paid-side figure itself has drifted between pages (15 min vs 5 min), which is evidence these
pages are not maintained against each other. **No Cloudflare page publishes a Free-plan
queue-consumer CPU figure.** The conservative decision above therefore stands unchanged, and the
empirical probe is the answer of record.

**Two corrections to this ADR's own premises, from the same pass:**

- **D1 Free allows only 50 queries per Worker invocation** (Paid: 1,000). The consumer is bound by
  *two* ceilings, not one: ~10 ms CPU **and** ≤50 D1 queries. Fetching `MAX_TOPIC_CANDIDATES = 20`
  candidates must be a single batched query, never a per-candidate loop, or the query ceiling is
  hit before the CPU ceiling ever matters. Binding on G2.
- **Whether HTTP pull consumers are available on the Free plan is not documented anywhere.** This
  ADR calls the pull consumer a "pre-approved fallback" — but a fallback whose availability on the
  target plan is unverified is not yet a fallback. The empirical probe must be extended to attempt
  a real `pull`/`ack` call against the Free account; until it does, this ADR's fallback is
  provisional and `core/RISK_REGISTER.md` R8 stays open on both counts.

## Consequences

- `services/processor/` and `services/resolver/` must be written to the light-consumer contract
  from the start, not optimized later — retrofitting a heavy consumer into a 10ms budget is a
  rewrite, not a tuning pass.
- Candidate selection is one batched D1 query, by construction (see the 50-query ceiling above).
- `scripts/probes/cloudflare-free-cpu/` must exist and be runnable by the operator against a real
  Free account; if Claude lacks credentials to run it, the script + exact reproducible
  instructions are still produced, and results are never fabricated.

## Verification owed at gate time (G0 item E, G2)

Empirical Free-plan CPU probe (trivial consumer with controlled CPU load) run on a real Free
account; G2 quota harness adds CPU profiling to every consumer invocation; p95 active CPU <=8ms
target measured under a representative event workload (200/day and 1000/day simulations);
`MAX_TOPIC_CANDIDATES` bound enforced and tested; no unindexed scan under either simulation.
