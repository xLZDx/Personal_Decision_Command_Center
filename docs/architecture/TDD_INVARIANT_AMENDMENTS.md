# TDD v0.3 FINAL — Invariant Amendments

**Status: PROPOSED FOR ADOPTION.**

This file exists because `docs/architecture/TDD_ERRATA.md` deliberately cannot amend INV-01..INV-31, while the project operating contract explicitly permits invariant changes through **ADR + independent review + operator approval**.

When this file is adopted under normal project governance, the amendments below supersede the named invariant text in `docs/architecture/TDD.md` §5 and any live document that merely repeats the superseded wording.

Historical reviews and frozen v0.3 artifacts remain historical evidence of the prior policy; they are not current authority once this amendment is adopted.

Authority for this change:

- operator direction, 2026-09-15: replace the obsolete absolute Telegram→AI prohibition with the current context/purpose/consent-scoped policy;
- `core/adr/ADR-012-telegram-ai-context-policy.md`;
- independent GPT-PM policy/architecture review must approve the exact adoption diff before merge.

---

## IA-001 — Amend INV-03

### Superseded v0.3 wording

`INV-03 Raw Telegram content never enters AI.`

### Replacement

**INV-03 (amended): Telegram content enters AI only when the current SourcePolicy authorizes that exact content/chat/context and purpose under the applicable Telegram ingress mode, consent/authorization state, provider-terms snapshot and provenance ancestry. Unknown, expired, revoked, incompatible or unprovable authorization fails closed to AI_DENY.**

Notes:

- Personal TDLib/private-chat data remains AI_DENY by default unless the required relevant-user, context-bounded consent can be demonstrated.
- Bot/Mini-App/Business-chatbot contexts are not automatically ALLOW; they become eligible only when their applicable disclosure/consent/authorization conditions are satisfied.
- Telegram provenance must never be removed to obtain ALLOW.

---

## IA-002 — Preserve INV-04, clarify consequence

### Existing invariant retained

`INV-04 Any value or assignment derived from Telegram content inherits Telegram provenance/taint, regardless of datatype.`

### Clarification

This invariant remains valid.

`Telegram provenance/taint` means **the value remains traceable to Telegram and must be evaluated by Telegram SourcePolicy at every AI boundary**. It no longer means permanent unconditional AI_DENY solely because the ancestor source is Telegram.

---

## IA-003 — Amend INV-05

### Superseded v0.3 wording

The v0.3 invariant and surrounding architecture bind MVP1 AI to a Gmail-only evidence bundle.

### Replacement

**INV-05 (amended): AI accepts only an explicitly policy-authorized evidence/context bundle produced by a fail-closed provenance + SourcePolicy evaluation. No arbitrary Topic, Stream, Person, generic serializable object, unverified derived value or source object may bypass this builder.**

For each contributing source-derived value, the builder must prove current AI eligibility for the exact purpose/context.

The current `GmailEvidenceBundle` implementation remains a safe subset until a separately reviewed runtime gate introduces additional eligible ingress paths.

This amendment does not itself enable Telegram AI at runtime.

---

## IA-004 — Amend INV-26

### Superseded v0.3 wording

`INV-26 Cross-channel Topic/Decision state is never fed back into AI in MVP1.`

### Replacement

**INV-26 (amended): Cross-source Topic/Decision state may enter AI only through the policy-authorized input builder and only when every contributing source-derived value is currently AI_ALLOW for the exact purpose/context with compatible scopes. Any AI_DENY, unknown ancestry, expired/revoked consent, incompatible scope or unresolved provenance denies the entire AI call.**

This rule is intentionally stricter than checking the Topic's top-level source list: eligibility is evaluated over submitted provenance ancestry, value by value.

---

## IA-005 — Composition rule

The normative AI composition rule becomes:

```text
ai_safe_for(value_or_context, purpose, context) =
  every submitted source-derived provenance ancestor has a current SourcePolicy ALLOW
  for the same purpose/context, and the scopes are mutually compatible.

unknown | mixed-with-deny | expired | revoked | incompatible | unresolved = DENY
```

`mixed` no longer means DENY merely because multiple providers contributed. Mixed provenance is allowed only when every contributor independently passes policy.

---

## IA-006 — No blanket Telegram indexing/training permission

Nothing in these amendments authorizes broad Telegram scraping, historical AI indexing, model training/fine-tuning, benchmarking, validation datasets or embeddings as a class.

Those uses require a separately reviewed policy basis and consent/authorization scope sufficient for that use. If not proven, DENY.

---

## IA-007 — Source-policy facts are external and mutable

Telegram terms must be re-verified against primary sources before any gate that implements or materially widens a Telegram AI path.

At minimum re-fetch:

- `https://core.telegram.org/api/terms`
- `https://telegram.org/tos/content-licensing`
- `https://telegram.org/tos/bot-developers`
- `https://telegram.org/privacy`

Record the dated evidence in `docs/architecture/EXTERNAL_ASSUMPTIONS.md`.

---

## Reading order

Once adopted, the architecture reading order for these invariants is:

1. `TDD_INVARIANT_AMENDMENTS.md` for amended invariants;
2. `TDD_ERRATA.md` for concrete non-invariant corrections;
3. frozen `TDD.md` for everything not superseded above.

Any live project document that repeats the old absolute Telegram→AI prohibition is stale and must be corrected or marked historical.
