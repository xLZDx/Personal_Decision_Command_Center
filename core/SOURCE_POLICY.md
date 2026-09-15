# Source Policy

Source: `docs/architecture/TDD.md`, `docs/architecture/TDD_INVARIANT_AMENDMENTS.md`, and the adopted ADRs. Policy-sensitive file — changes require ADR + independent review + operator approval.

## Core rule

Source provenance is always preserved, but source name alone is not the AI authorization decision.

AI eligibility is evaluated at runtime from:

- source + ingress mode;
- exact content/chat/context scope;
- processing purpose;
- current provider-terms snapshot;
- consent/authorization state required for that ingress mode/purpose;
- provenance ancestry of every submitted value;
- revocation/expiry state.

Unknown, incompatible, expired, revoked or unprovable authorization fails closed to `AI_DENY`.

The normative Telegram AI policy is `core/adr/ADR-012-telegram-ai-context-policy.md` plus `docs/architecture/TDD_INVARIANT_AMENDMENTS.md`.

## Telegram — current policy

Primary sources must be re-fetched before implementing or widening a Telegram AI path:

- `https://core.telegram.org/api/terms`
- `https://telegram.org/tos/content-licensing`
- `https://telegram.org/tos/bot-developers`
- `https://telegram.org/privacy`

Current Telegram terms prohibit broad AI/ML use of Telegram-obtained data absent the applicable exception/consent conditions, while also supporting legitimate Clients/Bots/Mini Apps and Telegram Business chatbot integrations. The engineering policy therefore does **not** use either obsolete extreme:

- NOT `Telegram => permanent AI_DENY`;
- NOT `Telegram => blanket AI_ALLOW`.

Instead Telegram AI eligibility is context/purpose/consent scoped and fail-closed.

### Personal TDLib/private-chat path

```text
normal receive/display                         ALLOWED DESIGN PATH
on-demand original drill-down                 ALLOWED DESIGN PATH
deterministic routing                         ALLOWED SUBJECT TO CURRENT TERMS/POLICY
AI without required scoped consent            DENY
AI with provable applicable scoped consent    ELIGIBLE FOR POLICY ALLOW
```

Personal account ownership alone is not sufficient proof that every relevant participant in an ordinary private chat has provided the consent required by the current Telegram AI/content-licensing terms.

### Bot / Mini App / Business chatbot paths

Direct user interaction with a Bot/Mini App/Business chatbot is not automatically AI_ALLOW, but may become eligible when the application:

- clearly discloses the intended processing;
- captures the required explicit/active/revocable/context-bounded consent or authorization;
- limits use to the disclosed service purpose;
- satisfies third-party API disclosure/authorization requirements where applicable;
- retains auditable consent + scope evidence;
- honors revocation/deletion obligations.

### Historical indexes / embeddings / datasets

MVP1 does not require Telegram embeddings or a broad Telegram AI index.

Do not build Telegram scraping, broad historical AI indexing, training/fine-tuning, benchmark/validation datasets or embeddings merely because a scoped inference call can be allowed. Those are separate purposes and remain DENY until their own permission/consent basis is proven and independently reviewed.

## Gmail

Gmail AI may be allowed when Gmail source policy, model/provider terms, retention/privacy settings and the selected provider configuration permit it.

Gmail provenance does not bypass the same fail-closed policy discipline; it is simply a different source-policy branch.

## Mixed-source AI boundary

Mixed Gmail + Telegram state is **not automatically denied** merely because Telegram contributed.

Before any mixed context is submitted to AI, every submitted source-derived value must pass provenance-aware policy evaluation for the exact purpose/context.

```text
ai_safe_for(context, purpose) =
  every submitted source-derived provenance ancestor is currently ALLOW
  for this purpose/context and all scopes are compatible
```

Any `DENY`, unknown ancestry, expired/revoked consent, incompatible scope or unresolved provenance denies the whole AI call.

## AI input contract

The old statement “MVP1 AI accepts exactly one input type: `GmailEvidenceBundle` forever” is superseded as architecture policy.

`GmailEvidenceBundle` remains a safe current runtime subset until a separately reviewed gate changes code.

The target boundary is a **policy-authorized evidence/context bundle** that can only be constructed after SourcePolicy + provenance validation. It must not accept arbitrary `Topic`, `Stream`, `Person`, generic serializable objects, source messages or unverified derived values.

This document does not itself enable a new runtime path.

## Provenance rule

Every content-derived value/assignment retains source provenance regardless of datatype.

Telegram provenance now means: “evaluate Telegram policy for this AI call”, not “permanent unconditional deny”.

Never strip or relabel provenance to manufacture `ALLOW`.

## Consent / authorization evidence

A future Telegram AI `ALLOW` path must retain machine-checkable evidence sufficient to prove the active scope, conceptually including:

- subject(s);
- ingress mode;
- exact chat/content/context scope;
- purpose;
- grant time;
- continued-consent / expiry / revocation state;
- provider-terms snapshot reference;
- provenance/evidence references.

A global “Telegram AI enabled” toggle is not proof for unrelated chats or purposes.

## Source content remains untrusted

No source message, email, Telegram update, bot payload or AI output may instruct the application to broaden policy, fabricate consent, remove provenance or bypass authorization.
