# ADR-009: Workers AI Provider / Original Gmail-Only Data-Use Decision

**Status:** PARTIALLY SUPERSEDED by `ADR-012-telegram-ai-context-policy.md`.

**Originally adopted:** G0 closure, 2026-09-10.

The provider/model/quota/privacy parts of this ADR remain relevant. The old architectural claim that MVP1 AI is permanently Gmail-only is superseded by ADR-012 plus `docs/architecture/TDD_INVARIANT_AMENDMENTS.md`.

## Context

At G0 the project deliberately chose the safest known policy: AI was optional and processed only Gmail-source-local evidence. That was a conservative product policy, not a timeless property of the provider abstraction.

Later policy reconciliation established a more precise source-neutral rule: AI input eligibility is evaluated per value/context from current SourcePolicy + provenance + purpose + consent/authorization. Telegram is deny-by-default, not permanently deny-by-source-name.

## Provider decision retained

- AI remains provider-abstracted; no domain service should import a provider SDK directly.
- Cloudflare Workers AI remains the reference provider unless a later gate changes it.
- Before production content is sent to any model, re-verify the selected model's license/provider terms, retention/privacy configuration, source-policy permission, and HARD_ZERO quota constraints.
- AI may be disabled entirely; core collection/routing/decision behavior must continue in a deterministic degraded mode.

## AI access boundary — superseded wording

The historical wording “`AIContextBuilder` accepts only `GmailEvidenceBundle`” is no longer the target architecture.

The target architecture is the policy-authorized evidence/context builder defined by ADR-012 and amended INV-05/26:

- every submitted source-derived value must carry provenance;
- every contributing provenance ancestor must be currently authorized for the exact purpose/context;
- any deny/unknown/expired/revoked/incompatible scope fails the whole call closed;
- arbitrary `Topic`, `Stream`, `Person`, source message or generic serializable objects cannot bypass the builder.

`GmailEvidenceBundle` remains a safe **current runtime subset** until a separately reviewed runtime gate changes code. Do not interpret this ADR as proof that Telegram AI is already implemented.

## Consequences

- Provider terms and source-policy terms are separate checks; a provider being safe for customer content does not authorize a source to be submitted.
- Mixed-source context may become eligible only when every submitted value independently passes policy.
- A source-name allow/deny shortcut is not sufficient for future connectors.

## Verification owed at gate time

Before any production AI path is added or widened:

- re-fetch Workers AI Customer Content policy and selected model terms;
- re-fetch the relevant source provider terms;
- verify policy-authorized input construction and fail-closed provenance walk;
- test AI-disabled and quota-exhausted behavior;
- for Telegram, satisfy the ADR-012 consent/context test matrix before enabling an ALLOW path.
