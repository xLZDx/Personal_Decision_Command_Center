# ADR-005: Value/Assignment Provenance DAG

**Status:** ADOPTED; AI-boundary portion PARTIALLY SUPERSEDED by `ADR-012-telegram-ai-context-policy.md` and `docs/architecture/TDD_INVARIANT_AMENDMENTS.md`.

**Originally adopted:** G0 closure, 2026-09-10.

## Context

Datatype-level taint is not sufficient. A source-derived intent enum, timestamp change, aggregate, membership relationship or assignment can carry source information even when no raw source string is present.

That finding remains fully valid.

What changed later is the policy decision attached to Telegram provenance: Telegram ancestry no longer means permanent source-name `AI_DENY`; it means the AI boundary must evaluate the current Telegram policy, purpose, consent/authorization and context for that exact value/call.

## Decision — retained provenance DAG

- Every source-derived value **and semantic assignment** is provenance-bearing. Datatype is irrelevant.
- Provenance ancestry must survive derivation, aggregation and cross-source composition.
- Unknown ancestry and cycles fail closed at security/policy boundaries.
- Provenance may not be stripped, rewritten or replaced with a system-owned label merely to make a value AI-eligible.
- `packages/provenance` / `packages/policy` must keep the ancestry walk testable and explicit.

## AI-boundary decision — superseded model

The historical v0.3 model accepted only `GmailEvidenceBundle` and rejected every combined Topic/Telegram-influenced state by construction.

That **source-name-specific restriction is superseded**.

The target input boundary is now:

```text
PolicyAuthorizedEvidenceContext
  <- constructed only after fail-closed SourcePolicy + provenance evaluation
```

The exact runtime type name is intentionally deferred to the implementing gate.

The builder must still reject arbitrary `Topic`, `Stream`, `Person`, `Decision`, generic `Serializable`, source messages or unverified derived-value arrays as direct inputs.

For every source-derived value included in an AI request, policy must prove current authorization for:

- source/ingress mode;
- exact purpose;
- exact chat/content/context scope where relevant;
- required consent/authorization state;
- provider-terms snapshot;
- compatible provenance scopes across the whole request.

Composition rule:

```text
ai_safe_for(request) =
  every submitted source-derived provenance ancestor is current ALLOW
  for this exact purpose/context
  AND all scopes are compatible

any DENY | unknown | expired | revoked | incompatible | unresolved => whole request DENY
```

Mixed Gmail+Telegram ancestry is therefore neither automatically denied nor automatically allowed.

## Telegram-specific consequence

Telegram-derived values retain Telegram provenance under amended INV-04.

At the AI boundary, that provenance triggers ADR-012 policy evaluation rather than unconditional permanent denial.

Personal TDLib/private-chat evidence remains deny-by-default unless the required relevant-user, context-bounded consent can be proven. Bot/Mini-App/Business-chatbot contexts may become eligible only when their applicable consent/disclosure/authorization requirements are satisfied.

## Processing order

Source-local enrichment may still run before cross-channel merge where that is the safest/cheapest implementation path. However, the architecture no longer claims that *all* AI must permanently precede cross-channel resolution.

A future mixed-source AI path is permitted only through the policy-authorized builder and requires its own reviewed runtime gate.

## Verification owed at implementation time

At minimum test independently:

- provenance survives string/number/datetime/boolean/enum/assignment/aggregate derivations;
- unknown/cyclic ancestry fails closed;
- arbitrary Topic/Stream/Person/shared objects cannot bypass the authorized builder;
- personal Telegram context without required consent => DENY;
- valid scoped Telegram consent/authorization can make the exact permitted context eligible;
- chat A consent cannot authorize chat B;
- purpose A consent cannot authorize purpose B;
- mixed Gmail+Telegram with all contributing nodes allowed => eligible;
- one denied/unknown/expired/revoked node => whole request DENY;
- provenance stripping cannot manufacture ALLOW;
- consent revocation affects subsequent calls;
- serializer/provider callers cannot bypass policy evaluation.

Historical G0/G2 tests that assert unconditional Telegram=>BLOCKED represent the old policy and must be revised only under the separately approved runtime migration gate; do not silently weaken them in a documentation-only change.
