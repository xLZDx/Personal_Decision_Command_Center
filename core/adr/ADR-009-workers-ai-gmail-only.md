# ADR-009: Gmail-Only AI Provider / Data-Use Decision

**Status:** ADOPTED at G0 closure, 2026-09-10 (G0 output K). GPT-PM VERDICT: APPROVE, 0 BLOCKER /
0 MAJOR. Approval anchor: G0 evidence commit `71ab1cf`. GPT-PM also cited a blob hash for
`governance/plans/G0_PLAN.md` that belongs to a later commit; see `governance/G0_CLOSURE_REPORT.md`.
G0 item C re-verified the Workers AI Customer Content statement verbatim and recorded the free
allocation of 10,000 Neurons/day, which TDD §65 did not carry
(`docs/architecture/EXTERNAL_ASSUMPTIONS.md` C). The per-model license/terms check before any
production Gmail content reaches AI remains owed at G3.
**Source:** `docs/architecture/TDD.md` §24, §25.

## Context

AI is optional in MVP1 and only ever processes Gmail-source-local evidence (see `ADR-005`). This
ADR records the provider choice and the data-use terms it currently rests on, so the choice is
revisited explicitly if the terms change rather than silently assumed.

## Decision

- AI is provider-abstracted (`AIProvider`: `WorkersAIProvider` | `NoAIProvider` | future
  `LocalProvider`); no domain service imports a provider SDK directly.
- Default/reference provider: Cloudflare Workers AI, reachable via REST API from outside Workers.
  As of the TDD's verification date, Cloudflare documents that Workers AI Customer Content is not
  used to train models made available on Workers AI and is not used to improve Cloudflare or
  third-party services without explicit consent.
- This does not remove the requirement to review, at G0 and again before any production Gmail
  content is sent to AI: the selected model's own license, the selected model provider's terms,
  the retention/privacy configuration, and the Gmail source policy's own permission to submit
  content to AI.
- AI may be disabled entirely (`NoAIProvider`); the system must still operate fully without it —
  Gmail decision detection degrades to deterministic/rule-based extraction only.

## Consequences

- `packages/policy` records the model/terms snapshot as an ADR-linked artifact, not tribal
  knowledge; a model/provider change requires updating this ADR.
- `AIContextBuilder` (see `ADR-005`) is the only caller of `AIProvider` — this ADR does not grant
  any other code path AI access.

## Verification owed at gate time (G0/G3)

Live re-fetch of Workers AI Customer Content policy and the selected model's license/terms before
any production Gmail content is sent to AI; AI-disabled mode functional test; AI-quota-exhausted
degrade-safely test.
