# ADR-012 — Telegram AI eligibility is context/purpose/consent scoped

**Status:** PROPOSED FOR ADOPTION

**Date:** 2026-09-15

**Supersedes in part:** `ADR-005-value-provenance-dag.md`, `ADR-009-workers-ai-gmail-only.md`, and the Telegram-AI assumptions encoded in TDD v0.3 invariants INV-03/05/26.

## Context

The v0.3 baseline adopted an intentionally conservative rule: Telegram raw/derived data never enters AI and MVP1 AI accepts only a Gmail-only evidence bundle. That rule was correct for the policy interpretation frozen at G0, but it is no longer the product policy we want to bind the implementation to.

Current Telegram terms distinguish several concepts that the old binary rule collapsed:

- ordinary/legitimate Telegram client, bot and mini-app operation;
- Telegram Bot Platform and Telegram Business chatbot interactions;
- AI/ML use of Telegram-derived data;
- explicit, informed, affirmative, continued/context-bounded consent;
- data submitted directly and voluntarily to a third-party app with explicit, active and revocable consent;
- provider/API disclosure and authorization duties.

Primary sources to re-verify at every gate that changes AI scope:

- https://core.telegram.org/api/terms
- https://telegram.org/tos/content-licensing
- https://telegram.org/tos/bot-developers
- https://telegram.org/privacy

This ADR is not legal advice. It is the product's fail-closed engineering policy for complying with the operator-approved interpretation of the current terms.

## Decision

Telegram provenance is always preserved, but Telegram provenance alone is NOT an automatic permanent `AI_DENY`.

AI eligibility is a runtime policy decision over the exact evidence/context being submitted to AI.

The decision must consider at least:

1. source and ingress mode;
2. exact content/chat/context scope;
3. processing purpose;
4. current provider-terms snapshot;
5. consent/authorization state required for that ingress mode and purpose;
6. provenance ancestry of every submitted value;
7. revocation/expiry state.

Default is `DENY` when any required fact is unknown, mixed, expired or not provable.

## Telegram ingress modes

The policy layer must be able to distinguish at least conceptually:

- `PERSONAL_TDLIB_CLIENT`
- `BOT_PLATFORM_DIRECT`
- `BUSINESS_CHATBOT`
- `MINI_APP`

Exact enum names are an implementation detail for the gate that introduces them.

### Personal TDLib account/client

Normal receive/display/drill-down and deterministic processing may continue as allowed by the existing client design.

AI use is **DENY by default**.

AI may be considered only for the specific content/chat/context where the required relevant-user consent can be demonstrated as explicit, informed, affirmative, continued and scope-bounded under the current Telegram terms.

Operator consent alone must not be assumed to cover counterparties in ordinary private chats.

### Bot / Mini App direct interaction

Data intentionally submitted directly to the TPA may become AI-eligible only when the product clearly discloses the intended processing and captures the consent/authorization required by current Telegram terms and applicable privacy law.

Consent must be active, revocable and scoped. A global 'Telegram AI enabled' checkbox is not sufficient evidence for unrelated chats/contexts.

### Telegram Business chatbot

Business-chatbot processing may become AI-eligible only where the chatbot is authorized for the relevant chat/context, the user-facing disclosure is truthful, any required authorization for third-party APIs is present, and the current Telegram AI/content-licensing conditions are satisfied.

The existence of Business chatbot support is not itself blanket authorization for AI processing of all private messages.

## Mixed Gmail + Telegram context

Mixed-source state is NOT automatically denied merely because one ancestor is Telegram.

Before any mixed context is sent to AI, the policy evaluator must walk the provenance of every submitted source-derived value.

The AI call is allowed only when **every** contributing source-derived node is currently `ALLOW` for that exact purpose/context and all scopes are compatible.

Any `DENY`, unknown ancestry, expired/revoked consent, incompatible consent scope or unresolved provenance fails the whole AI call closed.

This replaces the v0.3 rule that all combined Gmail+Telegram Topic/Decision state is permanently barred from AI.

## Provenance remains mandatory

ADR-005's provenance-DAG principle remains load-bearing.

Every source-derived value/assignment retains its source provenance regardless of datatype.

What changes is the meaning of provenance at the AI boundary:

- old model: any Telegram ancestor => permanent DENY;
- new model: Telegram ancestor => evaluate Telegram policy/consent/context for this call.

Do not strip Telegram provenance in order to obtain `ALLOW`.

## AI input contract

`GmailEvidenceBundle` must no longer be treated as the only possible AI input type forever.

A future runtime change should replace the source-name-specific boundary with a policy-authorized evidence/context bundle that can be constructed only after provenance and consent/policy evaluation.

The type boundary must still prevent arbitrary `Topic`, `Stream`, `Person`, generic serializable objects or unverified derived values from entering AI.

No runtime contract change is authorized by this ADR alone; it requires its own gate/plan/tests.

## Historical indexing / embeddings

This ADR does NOT create blanket permission to build Telegram embeddings, historical vector indexes, training sets, benchmark sets or broad archives.

Such uses remain `DENY` unless a separately reviewed use case proves the necessary Telegram permission/consent scope and retention/deletion obligations. MVP1 does not need such an index to operate.

## Consent record requirements

Any future Telegram-AI `ALLOW` path must have auditable, machine-checkable evidence sufficient to evaluate the current scope, including conceptually:

- consent/authorization subject(s);
- ingress mode;
- chat/content/context scope;
- permitted purpose;
- granted-at;
- revocation/expiry/continued-consent status;
- terms/policy snapshot reference;
- provenance/evidence references.

Exact schema belongs to the implementing gate.

Consent revocation must stop future AI use immediately for that scope. The implementation gate must also define deletion/invalidation handling for retained source-derived data or AI outputs where required by provider terms or applicable law.

## Security rule

Source content is untrusted data. Neither Telegram messages nor any other source content may instruct the application or model to change policy, fabricate consent, broaden consent scope or bypass provenance validation.

## Consequences

- Existing absolute `Telegram -> AI DENY` documentation must be reconciled.
- INV-03, INV-05 and INV-26 require a formal invariant amendment; INV-04 (provenance inheritance) remains conceptually valid.
- `ADR-009-workers-ai-gmail-only.md` becomes historical/superseded for the Gmail-only boundary, while its provider/model/quota concerns remain relevant where not contradicted.
- `ADR-004` and the normalized-event runtime guard that rejects every Telegram `ai_policy: ALLOW` require a later reviewed runtime change; documentation must not pretend they already implement this ADR.
- No AI path becomes enabled until runtime policy/consent enforcement and tests exist.

## Required tests for the implementing gate

At minimum, independently verify:

- personal TDLib chat without required consent => DENY;
- Telegram context with unknown/expired/revoked consent => DENY;
- Bot/Mini-App direct context with valid scoped consent => eligible for ALLOW subject to all other policies;
- consent for chat A cannot authorize chat B;
- consent for one purpose cannot authorize another purpose;
- mixed Gmail + Telegram with all contributing nodes allowed => eligible;
- mixed context with one denied/unknown Telegram node => entire call DENY;
- provenance stripping cannot convert a denied value to allowed;
- revocation takes effect before subsequent AI call;
- no generic Topic/object bypass of the policy-authorized input builder.

## Review / re-verification rule

Telegram terms are external mutable facts. Re-fetch the primary sources before implementing or widening any Telegram AI path, and record the dated snapshot in `docs/architecture/EXTERNAL_ASSUMPTIONS.md`.
