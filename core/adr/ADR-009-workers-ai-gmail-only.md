# ADR-009: Gmail-Only AI Provider / Data-Use Decision

**Status:** DRAFT (G0 output K) — pending operator/GPT-PM adoption at G0 closure and pending G0
item C (live re-verification of Workers AI Customer Content / model terms).
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
