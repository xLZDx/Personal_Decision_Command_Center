# ADR-010: HARD_ZERO Cost Mode

**Status:** DRAFT (G0 output L) — pending operator/GPT-PM adoption at G0 closure.
**Source:** `docs/architecture/TDD.md` §64, §16.3, §17.

## Context

MVP1's cost target is $0/month mandatory recurring infrastructure cost. Every free-tier platform
(Cloudflare Workers/Queues/D1/Analytics Engine) has a hard usage ceiling; the risk is not "it costs
money" but "it silently starts costing money" via an auto-upgrade path or a paid fallback added
for convenience during implementation.

## Decision

`COST_MODE=HARD_ZERO` is a startup/deployment-time check that **rejects**: any paid AI fallback,
any paid queue fallback, any auto-upgrade billing path, any unapproved paid SaaS dependency.

Budget-exhaustion behavior is degrade-not-fail-silently-nor-pay:

- Queue soft guardrail `MAX_DISPATCHED_QUEUE_MESSAGES_PER_DAY = 2500` (configurable downward only
  without review). At/near the guardrail: new events keep being durably accepted in D1, outbox
  stays `PENDING`, Queue dispatch pauses, OPS shows `HARD_ZERO_DEGRADED_QUEUE_BUDGET`, processing
  resumes after the next quota window — no automatic paid upgrade is triggered.
- OPS displays current quota use and the declared mandatory recurring cost at all times.

The $0/month claim is explicitly conditional (TDD §64): free tiers stay within published limits,
and an already-owned or genuinely free always-on host exists for the Telegram connector. This is
not a promise that third-party free tiers remain unchanged forever (see `RISK_REGISTER.md` R5).

## Consequences

- CI/deployment must be able to prove `HARD_ZERO` is actually enforced (a config flag that is not
  checked anywhere is not a control).
- Every gate that adds a new external dependency must state, in its plan, whether that dependency
  has a free tier sufficient for MVP1 and what the HARD_ZERO degrade path is if that tier is
  exceeded.

## Verification owed at gate time (G2, G8)

Startup checks reject paid AI fallback/paid queue fallback/auto-upgrade/unapproved paid dependency
(negative tests, not just code review); Queue soft-budget-reached scenario test (durable accept
continues, dispatch pauses, OPS shows the degraded state, next-window recovery works, no paid
upgrade fires); OPS quota dashboard shows live D1/Queue/Workers/Analytics usage against published
free-tier limits.
