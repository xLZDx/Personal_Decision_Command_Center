# Provenance Model

Canonical source: `docs/architecture/TDD.md` §7 (value/assignment provenance DAG), §7.1-7.2 (MVP1
AI boundary, composition rule), §8 (canonical state vs. display projections). Binding decision
record: `../../core/adr/ADR-005-value-provenance-dag.md`.

Index only — see `ADR-005` for the actual decision and `SOURCE_POLICY.md`/`../../core/SOURCE_POLICY.md`
for the policy this model enforces. Implemented in `packages/provenance` and `packages/policy`
starting at G2.

## The one rule that matters most

Every value **and every semantic assignment caused by source content** is provenance-bearing,
regardless of datatype. A Telegram-triggered enum assignment, a Telegram-advanced timestamp, and
a Topic's mere membership (which Gmail messages ended up grouped with which Telegram messages) are
all Telegram-tainted, exactly like a raw Telegram string would be.

```
ai_safe(value) = all provenance ancestors are AI_ALLOW
```

Unknown/mixed ancestry = `AI_DENY`. Fail closed, not fail open.
