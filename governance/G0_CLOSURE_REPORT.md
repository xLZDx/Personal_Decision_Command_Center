# G0 Closure Report

**Gate:** G0 — implementation-readiness verification + ADR freeze
**Status:** **CLOSED**
**Date:** 2026-09-10
**Plan:** `plans/G0_PLAN.md` (Plan ID `pdos-g0-2026-09-10`)
**Final gate authority:** GPT-PM — **VERDICT: APPROVE, 0 BLOCKER, 0 MAJOR**
**Evidence commit:** `71ab1cf`

## What GPT-PM approved, and the anchor discrepancy

GPT-PM's verdict stated the approval was anchored to `governance/plans/G0_PLAN.md` blob
`b930873f096e4f26bb3d8fcc7d1fbae0f8e60f10` **and** to G0 evidence commit `71ab1cf`, adding
explicitly that "commit b784265 с G1 не входит в этот approval."

**Those two anchors contradict each other, and the discrepancy is recorded rather than quietly
resolved.** Verified locally:

```
git rev-parse 71ab1cf:governance/plans/G0_PLAN.md  ->  f69c7f7a69b1d05b843b8542668d2c2019da2d7d
git rev-parse b784265:governance/plans/G0_PLAN.md  ->  b930873f096e4f26bb3d8fcc7d1fbae0f8e60f10
```

The cited blob is the version of the plan **as it exists in b784265** — the very commit the
verdict excludes. Cause: GPT-PM read the file from GitHub's default branch, which was already at
b784265, while intending to anchor to the G0 evidence commit.

**Materiality: none.** The two blobs differ only in markdown table-separator padding applied by
prettier during the G1 commit; `git diff --ignore-all-space --ignore-blank-lines` between them
shows one changed line, the `|---|---|---|` separator row. No sentence, status, item or commitment
differs.

**Disposition:** this report treats commit `71ab1cf` as the operative approval anchor, because
that is what the verdict's own prose describes and what the approval reasoning addressed. The
blob-hash citation is recorded here as an inaccuracy in the verdict, not corrected silently and
not used to widen the approval to cover G1. Flagged back to GPT-PM.

Lesson worth keeping: a hash-bound approval must be requested against a frozen artifact. Asking
for one while later commits are still landing on the same branch produces exactly this ambiguity.

## G0 required outputs — final state

| Item | Deliverable                                                            | State                                                                                                   |
| ---- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A    | Adopt/freeze TDD v0.3 in repo                                          | DONE — `docs/architecture/TDD.md`                                                                       |
| B    | Live Telegram API + Content Licensing snapshot                         | DONE — `docs/architecture/EXTERNAL_ASSUMPTIONS.md` B                                                    |
| C    | Live Cloudflare Workers/Queues/D1/Analytics/Tunnel/Workers-AI snapshot | DONE — `EXTERNAL_ASSUMPTIONS.md` C                                                                      |
| D    | Live Gmail watch/history snapshot                                      | DONE — `EXTERNAL_ASSUMPTIONS.md` D                                                                      |
| E    | Empirical Cloudflare Free CPU harness + operator instructions          | **HARNESS DONE, NOT RUN** — `scripts/probes/cloudflare-free-cpu/`; needs an operator-owned Free account |
| F    | ADR-002 Gmail+Telegram scope lock                                      | ADOPTED                                                                                                 |
| G    | ADR-003 direct TDLib                                                   | ADOPTED                                                                                                 |
| H    | ADR-005 provenance DAG + Gmail-only pre-aggregation AI boundary        | ADOPTED                                                                                                 |
| I    | ADR-007 Tunnel Content Gateway + auth chain + E2E envelope             | ADOPTED                                                                                                 |
| J    | ADR-008 opaque push                                                    | ADOPTED                                                                                                 |
| K    | ADR-009 Gmail-only AI provider/data-use                                | ADOPTED                                                                                                 |
| L    | ADR-010 HARD_ZERO                                                      | ADOPTED                                                                                                 |
| M    | ADR-011 Queue consumer runtime                                         | **ADOPTED WITH R8/R9 OPEN**                                                                             |
| N    | Threat model                                                           | REVIEWED AND ADOPTED (GPT-PM fresh-context SEC/PRIV review)                                             |
| O    | Gate-manifest integrity mechanism design                               | DONE — `GATE_MANIFEST_INTEGRITY.md` (design; implementation is G1)                                      |

## The three findings G0 exists to have caught

1. **NB1 is not resolved by documentation, and the contradiction is three-way.** No Cloudflare page
   publishes a Free-plan queue-consumer CPU figure; the Workers limits CPU table has no
   queue-consumer row at all, the Queues page claims 30 s/5 min applies to Free, and the pricing
   page puts 15 minutes in the _Paid_ column. The paid figure differs between pages. The
   conservative 10 ms assumption stands; measurement, not documentation, is the answer of record.
2. **D1 Free allows only 50 queries per Worker invocation** — a second ceiling absent from TDD §65.
   The consumer is bound by CPU _and_ query count, so candidate selection must be a single batched
   query rather than a per-candidate loop.
3. **Telegram prohibits more than the TDD recorded** — scraping, indexing, harvesting, validate and
   benchmarking, beyond train/fine-tune. A vector/embedding index over Telegram content is
   prohibited with zero model training involved.

Also: `ADR-011`'s pull-consumer fallback has no published Free-plan eligibility (R9); Workers AI
free allocation is 10,000 Neurons/day; Analytics Engine limits are now officially published,
closing the v0.2 review's MIN-5; and Google's documented Gmail 404 recovery is a _full_ sync, so
this project's bounded recovery is its own decision and is labelled as such.

## Carried forward as blocking G2 preflight

Per GPT-PM's ruling, R8/R9 are not "check on this eventually" — they gate G2:

```
G2-PREFLIGHT-01  Run the Free-account Queue-consumer CPU probe.
G2-PREFLIGHT-02  Attempt a real HTTP pull + ack on the same Free account.
G2-PREFLIGHT-03  Record the D1 <=50-queries-per-invocation budget in the quota harness.
```

No Queue runtime choice may be declared VERIFIED until all three complete. If PREFLIGHT-02 shows
pull consumers are unavailable on Free, ADR-011 must stop describing one as a fallback.

## Status of G1

**G1 is NOT closed and was not authorized as a gate.** Commit `b784265` (toolchain, CI, contracts)
is recorded as **bootstrap implementation, not gate-approved work** — GPT-PM's ruling, which also
declined to revert it purely to reconstruct process. Its remediation is tracked separately in
`plans/G1_REMEDIATION_PLAN.md`. G2 does not begin until G1 closes properly.

## Deviation recorded honestly

G1 implementation began before G0 had been formally closed and before G1 had a plan, a manifest,
or a GO. That violates the repository's own gate contract (`../CLAUDE.md` §4,
`../core/PLAN_MASTER_GATES.md`). It is recorded here as a bootstrap deviation rather than
presented as an authorized gate, and the remediation plan starts from that admission.
