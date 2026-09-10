# ADR-002: Gmail + Telegram MVP1 Scope Lock

**Status:** ADOPTED at G0 closure, 2026-09-10 (G0 output F). GPT-PM VERDICT: APPROVE, 0 BLOCKER /
0 MAJOR. Approval anchor: G0 evidence commit `71ab1cf`. GPT-PM also cited a blob hash for
`governance/plans/G0_PLAN.md` that belongs to a later commit; see `governance/G0_CLOSURE_REPORT.md`.
**Source:** `docs/architecture/TDD.md` §3-4, §55, §79-80; `core/MVP1_SCOPE_LOCK.md`.

## Context

Personal Decision OS's core hypothesis (one decision surface instead of two inboxes) needs at
least two genuinely different channel types to be a real test, but every additional source adds
connector, compliance and provenance surface. The v0.2 adversarial review confirmed the two-source
scope was already consistently enforced across the TDD (B1: CLOSED) and asked only that it stay
that way.

## Decision

MVP1 source scope is exactly Gmail + the operator's personal Telegram account. No other source
(Outlook, Slack, WhatsApp, Signal, Beeper/mautrix, LinkedIn, Discord, X, SMS, native mobile apps,
etc.) may become an MVP1 implementation dependency in any gate. A later source may get a design
placeholder/interface but not an implementation, without an operator-approved scope revision to
this ADR.

## Consequences

- The cross-channel proof scenario (TDD §79) is exactly one Telegram message + one Gmail thread
  producing one Topic/Decision — this is the mandatory MVP1 demonstration, not an example among
  many.
- `services/`, `connectors/` directories for any other source are out of scope; do not create them
  speculatively.
- Quantitative evaluation (TDD §80) is scoped to two-source cases; do not invent metrics for
  sources that do not exist yet.

## Verification owed at gate time

None — this is a scope decision, not an external-fact claim. Enforced by code review + `gov-01`
agent checking no non-MVP1 connector/service directory appears in a gate's diff.
