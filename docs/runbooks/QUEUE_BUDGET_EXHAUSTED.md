# Runbook: Queue Budget Exhausted

**Status:** placeholder — to be written with real steps at G2 (Queue/Reliability gate).
**Trigger:** OPS shows `HARD_ZERO_DEGRADED_QUEUE_BUDGET` (TDD §16.3, `../../core/adr/ADR-010-hard-zero-cost.md`).

New events keep being durably accepted in D1; outbox stays `PENDING`; Queue dispatch pauses;
processing resumes after the next quota-window reset. No paid upgrade fires automatically — if
this state recurs often, that is a capacity-planning/scope question for the operator+GPT-PM, not
something to silently work around by raising the guardrail without review.
