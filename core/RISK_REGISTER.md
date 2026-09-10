# Risk Register

Source: `docs/architecture/TDD.md` §85 (accepted residual risks) plus the closed
BLOCKER/MAJOR findings from `governance/reviews/02-tdd-v0.2-adversarial-review.md`, tracked here so
their closure conditions stay visible gate-by-gate instead of buried in a review transcript.

## Accepted residual risks (TDD §85)

| ID | Risk | Mitigation | Status |
|---|---|---|---|
| R1 | Telegram deterministic cross-channel aggregation remains contractually YELLOW/UNCLEAR | Raw Telegram content stays source-local; only deterministic identifiers cross into Topic state; periodic ToS re-review | ACCEPTED, re-review at G0 (item B) and quarterly |
| R2 | $0/month requires an already-owned/free always-on host for TDLib | Host downtime degrades Telegram ingestion/drill-down until recovery, does not lose durably-accepted state | ACCEPTED |
| R3 | Gmail Pub/Sub may require a GCP billing-account attachment despite $0 usage | Explicit `GMAIL_COLLECTION_MODE=POLL` fallback if operator refuses | ACCEPTED, verify at G3 |
| R4 | Telegram semantic recall ceiling (no ML on Telegram) | Precision preferred over recall by design; deterministic identifiers/mappings/timing only | ACCEPTED |
| R5 | Free-tier platform drift (Cloudflare/GCP quotas/semantics may change) | Live gate snapshots + HARD_ZERO + quota telemetry reduce but do not eliminate this | ACCEPTED |
| R6 | Source deletion before drill-down (no central raw retention by default) | Intentional data-minimization trade-off | ACCEPTED |
| R7 | Push timing metadata observable by FCM/APNs even though payload is opaque | Documented residual metadata leakage in threat model | ACCEPTED, INFO severity |
| R8 | Cloudflare Queue CPU documentation ambiguity (Free vs Paid) | Architecture assumes the stricter 10ms Workers Free budget; empirical probe at G0/G2 confirms actual account behavior | **OPEN — worsened.** Live re-verification 2026-09-10 found the contradiction is now three-way and no page publishes a Free-plan queue-consumer CPU figure at all. Probe harness written (`scripts/probes/cloudflare-free-cpu/`), NOT YET RUN — needs an operator-owned Free account |
| R9 | `ADR-011`'s pre-approved fallback (HTTP pull consumer) may not be available on the Free plan — Cloudflare documents the mechanics but publishes **no plan-eligibility statement** | Extend the CPU probe to attempt a real `pull`/`ack` call on the Free account before relying on the fallback | **OPEN — new, found at G0.** A fallback whose availability is unverified is not yet a fallback |
| R10 | D1 Free allows only **50 queries per Worker invocation** (Paid: 1,000) — a second ceiling the TDD never recorded | Candidate selection must be one batched query, never a per-candidate loop; G2 quota harness must count queries per invocation, not just CPU | **OPEN — new, found at G0.** Binding constraint on G2 design |

## Findings closed in v0.3 (from the v0.2 adversarial review), tracked for gate-time verification

| ID | Finding | v0.3 closure claim | Verification owed |
|---|---|---|---|
| NB1 | Queue-consumer CPU budget assumption was wrong for Free plan (10ms, not 30s/5m) | Design now assumes ≤10ms active CPU; HTTP-pull-consumer fallback pre-approved via ADR-011 | G0/G2 empirical CPU probe must confirm the actual Free-account limit before this is more than a documentation fix |
| NM2 | Enum/aggregate/existential Telegram leakage into AI via shared Topic/Stream fields | MVP1 AI accepts only `GmailEvidenceBundle`, built before cross-channel merge; combined state never re-enters AI | Automated policy test (TDD §70) must prove this at G2/G6, not just be asserted in docs |
| NM3 | Gate-manifest integrity was self-referential (implementer could edit the file that constrains the implementer) | Gate manifests are operator-owned protected paths; CI validates hash against operator-controlled state outside the implementer's writable branch | G0 item O (mechanism design) + G1 CI implementation must actually enforce this, not just describe it |
| NM4 | Reconciler could loop on a permanently-failing ("poison") event, burning Queue budget | Reconciler excludes terminal `FAILED`/`DLQ`; `MAX_PROCESSING_ATTEMPTS=5` default; mandatory no-loop resilience test | G2 resilience test must actually simulate a poison event and prove single terminal DLQ transition |

Do not mark any row above CLOSED in this register until the "verification owed" work has run and
produced evidence — a design-level fix in the TDD text is necessary but not sufficient (global
CLAUDE.md §17: "A green test suite is a claim that has to be earned").
