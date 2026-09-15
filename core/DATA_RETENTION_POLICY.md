# Data Retention Policy

Policy-sensitive file — changes require ADR + independent review + operator approval.

Current architecture authority includes `docs/architecture/TDD_INVARIANT_AMENDMENTS.md` and
`core/adr/ADR-012-telegram-ai-context-policy.md` in addition to the non-superseded retention rules
from frozen TDD §51-52.

## Retention classes

```text
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
- Central source refs / routing metadata: active topic + 30 days after resolution (default), unless
  a stricter applicable provider/consent rule requires earlier deletion.
- Any retained Telegram-derived value remains Telegram-provenance-bearing regardless of retention
  class. **Provenance-bearing does not mean permanent AI_DENY**; AI eligibility is separately
  evaluated under ADR-012 for the exact purpose/context.
- A future consent-enabled Telegram AI path must define what happens when consent/authorization is
  revoked or expires, including any required deletion, invalidation or exclusion of retained
  source-derived data / AI outputs from future processing.
- Scoped inference permission must not be treated as permission to retain a broad historical
  Telegram corpus/vector index.

## Gmail

- Central raw body: not stored by default.
- Derived operational state: active + 180 days (default).
- User-promoted knowledge/reference: until the user removes it or policy changes.
- AI/provider retention remains subject to the selected provider/model/source policy.

## Audit

- 365 days default, no raw source content.
- Consent/policy decisions may be audit-recorded using identifiers/scopes/status rather than raw
  message bodies.

Retention periods are configuration with safe maximums, reviewable in OPS. Deletion of a source
connection revokes stored credentials; retention jobs are idempotent and produce a structured run
report. The application does not claim to delete the original message from Telegram/Gmail unless a
future explicit source action adds that capability.
