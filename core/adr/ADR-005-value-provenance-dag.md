# ADR-005: Value/Assignment Provenance DAG + Gmail-Only Pre-Aggregation AI Boundary

**Status:** DRAFT (G0 output H) — pending operator/GPT-PM adoption at G0 closure. Resolves NM2
(the v0.2 adversarial review's enum/aggregate/existential Telegram-leakage MAJOR).
**Source:** `docs/architecture/TDD.md` §7, §7.1, §7.2, §8, §24.

## Context

Datatype-level taint (raw Telegram text never reaches AI) is not sufficient. The v0.2 review
(NM2) showed a Telegram-derived intent enum, a Telegram-advanced `updated_at`, or the mere
membership of a combined Topic (which Gmail messages ended up next to which Telegram messages)
can each leak Telegram-originated information into an AI context even when no Telegram string is
literally present. The review required choosing and documenting one of two variants explicitly.

## Decision

**Variant A (adopted):** the MVP1 AI context is built *exclusively* from Gmail-evidence-scoped
objects. No Topic/Stream/Person/shared-state field, and no aggregate derived from cross-channel
membership, ever enters an AI request — regardless of whether every individual field looks
Gmail-only in isolation.

Concretely:

- Every value **and every semantic assignment** caused by source content is provenance-bearing;
  datatype is irrelevant (`ProvenanceValue<T>` wrapper, TDD §7).
- The only accepted MVP1 AI input type is `GmailEvidenceBundle`, built from Gmail source evidence
  **before** cross-channel topic resolution (TDD §24.1). There is no overload accepting `Topic`,
  `Stream`, `Person`, `Decision`, `CrossChannelContext`, or a generic `DerivedValue[]`.
  `AIContextBuilder.build(GmailEvidenceBundle) -> AIRequest` is the only entry point.
  Runtime `assert_ai_safe()` additionally traverses provenance and fails closed.
- After the deterministic cross-channel resolver combines Gmail and Telegram evidence into one
  Topic/Decision, that combined state is **never** sent back to AI in MVP1 (TDD §24.2). A future
  AI summary/recommendation over a combined topic is explicitly POST-MVP and needs its own
  source-policy/compliance review.
- Composition rule: `ai_safe(value) = all provenance ancestors are AI_ALLOW`. Unknown/mixed
  ancestry = `AI_DENY` (fail closed).

This is stricter than Variant B (allowing Telegram-tainted enum/state/date fields into context as
an accepted bounded leak) — Variant A removes the existential membership-selection channel
entirely by construction rather than documenting it as accepted residual risk.

## Consequences

- `intent_class`, `updated_at`/`occurred_at` when advanced by a Telegram event, and combined-topic
  participant/evidence counts are never passed to the AI serializer, full stop — no "system
  constant, so it's fine" exception, because the *assignment* still carries provenance even when
  the value itself is a plain enum.
- Gmail AI enrichment must run and produce `GmailSourceEnrichment` **before** the cross-channel
  resolver runs (mandatory processing order, TDD §7.1).
- `packages/provenance` and `packages/policy` must implement the DAG and the fail-closed
  composition rule as testable primitives, not documentation.

## Verification owed at gate time (G2 primitives, G6 AI integration)

Mandatory automated tests (TDD §70), each an independent assertion, not one umbrella test:
raw Telegram -> AI BLOCKED; Telegram-derived string/number/datetime/boolean/display-name/enum
assignment/count-aggregate/routing-hint -> AI BLOCKED; nested/mixed/unknown ancestry -> AI BLOCKED;
`Topic`/`Stream`/`Person`/shared-identity object -> AI API TYPE/SCHEMA BLOCKED (not just policy-
blocked — the type system itself must reject it); `GmailEvidenceBundle` with Gmail-only eligible
ancestry -> ALLOWED; Gmail AI enrichment provably occurs before cross-channel resolution; combined
Gmail+Telegram Topic never serialized into an AI request; AI serializer cannot bypass the
provenance gate via any code path.
