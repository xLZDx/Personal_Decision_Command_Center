# ADR-008: Opaque Push

**Status:** DRAFT (G0 output J) — pending operator/GPT-PM adoption at G0 closure.
**Source:** `docs/architecture/TDD.md` §32.

## Context

An earlier design (v0.1) put content (sender, title, excerpt) directly in the push payload. This
is both a privacy leak (push infrastructure/OS notification history sees the content) and a
provenance-boundary problem (a Telegram-derived title in a push payload would need its own AI/
taint reasoning at the push layer). The v0.2 review closed this (B3: CLOSED) and asked only that
it stay closed.

## Decision

Push payload MUST contain no source-derived content. Allowed payload shape:

```json
{ "type": "STATE_CHANGED", "notification_id": "n-123", "schema_version": 1 }
```

Not allowed in the push transport, ever: sender name, message excerpt, topic title, decision
question, source-derived deadline, a project label if derived from source, source content. For
MVP1, generic local notification text may be `"Personal Decision OS has new updates."`.

The client wakes on push and performs an authenticated state fetch (`sync-on-open`). Push is an
optimization, never source of truth — if push is delayed/lost, opening/resuming the PWA performs
state sync and the Today screen becomes correct. No percentage/guaranteed delivery SLA is claimed.

## Consequences

- `services/notification/` never builds a payload from `TopicDisplay`/decision text — only from
  the opaque shape above.
- Accepted residual risk (INV-31, R7): FCM/APNs can observe that a push occurred and when, even
  though the content is opaque. Documented in the threat model as INFO, not mitigated further.

## Verification owed at gate time (G7)

Push payload inspected on the wire and proven opaque (no sender/title/question/deadline/source
text in any field); lost/delayed push does not lose state; resume/open sync repairs the
notification gap.
