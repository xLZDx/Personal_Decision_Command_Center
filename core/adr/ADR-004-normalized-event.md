# ADR-004: Normalized Event Contract

**Status:** ADOPTED at G2 planning, 2026-09-12; Telegram-AI boundary note updated by `ADR-012-telegram-ai-context-policy.md`.

**Source:** `docs/architecture/TDD.md` §13, provenance ADRs, and implementation `packages/contracts/src/event.ts`.

## Context

Every connector (Gmail, Telegram, future sources) must produce one shared envelope shape before an event reaches D1, the queue, or shared processing code. The normalized contract keeps provider-specific raw content out of central transport and preserves source/provenance metadata.

## Decision

One connector-neutral `NormalizedEvent` schema, `.strict()` so unapproved `body`/`text`/`snippet` fields fail at the boundary.

Current implementation fields include:

```text
event_id
source
source_account_id
source_event_id
source_thread_id
event_type
direction
occurred_at
received_at
content_locator
routing_hints[] with provenance
source_policy_id
trace_id
schema_version
source_version
```

The exact current schema/version is defined by `packages/contracts/src/event.ts`; do not use this ADR's historical field list as a substitute for the executable contract.

Raw body/content is never part of the normalized central event contract.

## Telegram AI-policy guard — transitional runtime behavior

The current `NormalizedEventSchema` contains a G2-era defence-in-depth refinement rejecting a Telegram routing hint whose `ai_policy` claims `ALLOW`.

That behavior implemented the old permanent `Telegram => AI_DENY` policy and is now **architecturally superseded by ADR-012 plus the invariant amendments**.

Do NOT interpret the current runtime refinement as the desired long-term policy.

Equally, do NOT silently delete/weaken it in a documentation-only change. It remains the current executable behavior until a separately approved runtime migration introduces the new context/purpose/consent-aware policy model and corresponding tests.

The target rule is:

- routing hints retain provenance;
- source-name alone does not determine AI permission;
- AI eligibility is evaluated through fail-closed SourcePolicy + provenance + purpose/context + consent/authorization;
- malformed or unprovable policy metadata fails closed.

A future runtime gate must replace the unconditional Telegram refinement with a representation that cannot let a connector self-authorize AI merely by writing `ALLOW` into its own payload. Connector claims are input facts, not authority.

## Idempotency

Idempotency remains based on source-stable identity/revision fields, never retry-specific transport fields such as `received_at`, `trace_id` or a newly generated ingest UUID.

The executable `idempotencyKey()` and its tests are the source of truth for the exact current tuple/encoding.

## Consequences

- raw source content cannot leak through the normalized event envelope by adding an undeclared field;
- routing hints remain provenance-tagged;
- policy authorization is a downstream trusted policy decision, not a connector-controlled boolean;
- the current Telegram `AI_ALLOW` parse rejection is a known transitional guard awaiting its own reviewed migration, not an invariant to copy into new code/docs.

## Verification for the runtime policy migration

When the new Telegram AI policy is implemented, tests must prove at minimum:

- connector-supplied metadata cannot self-authorize AI;
- Telegram provenance is preserved;
- personal TDLib context without required consent remains DENY;
- valid scoped consent/authorization can produce an eligible context only through trusted policy evaluation;
- unknown/expired/revoked/incompatible authorization fails closed;
- raw content remains impossible to smuggle into the normalized envelope;
- existing idempotency semantics do not regress.
