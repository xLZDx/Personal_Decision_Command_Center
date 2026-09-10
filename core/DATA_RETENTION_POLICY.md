# Data Retention Policy

Source: `docs/architecture/TDD.md` §51-52. Policy-sensitive file — changes require ADR + independent
review + operator approval.

## Retention classes

```
R0_TRANSIENT
R1_SHORT
R2_OPERATIONAL
R3_USER_KNOWLEDGE
R4_AUDIT
```

## Telegram

- Central raw text: **NOT STORED by default.**
- Connector-side TDLib/client cache: minimum operationally necessary; not backed up as a long-term
  message archive by default.
- Central source refs / routing metadata: active topic + 30 days after resolution (default).
- Any retained Telegram-derived value remains provenance-tainted regardless of retention class.

## Gmail

- Central raw body: not stored by default.
- Derived operational state: active + 180 days (default).
- User-promoted knowledge/reference: until the user removes it or policy changes.

## Audit

- 365 days default, no raw content.

Retention periods are configuration with safe maximums, reviewable in OPS. Deletion of a source
connection revokes stored credentials; retention jobs are idempotent and produce a structured run
report. The application does not claim to delete the original message from Telegram/Gmail unless a
future explicit source action adds that capability.
