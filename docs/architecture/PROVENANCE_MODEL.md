# Provenance Model

Current authority:

1. `TDD_INVARIANT_AMENDMENTS.md`
2. `core/adr/ADR-012-telegram-ai-context-policy.md`
3. `core/adr/ADR-005-value-provenance-dag.md`
4. frozen `TDD.md` where not superseded

Implemented in `packages/provenance` / `packages/policy` starting from G2-era primitives and widened only under separately approved runtime gates.

## The rule that matters most

Every value **and every semantic assignment caused by source content** is provenance-bearing, regardless of datatype.

Examples include:

- raw/source-derived strings;
- enum/intent assignments;
- timestamps whose business meaning changed because of source evidence;
- counts/aggregates;
- membership/association decisions;
- derived priority/routing state where source evidence caused the assignment.

Telegram-derived values keep Telegram provenance. That provenance is **not removed** merely because a current policy may authorize one AI use.

## AI composition rule

The old shortcut:

```text
Telegram ancestor => permanent DENY
```

is superseded.

Current rule:

```text
ai_safe_for(request, purpose, context) =
  every submitted source-derived provenance ancestor has a current SourcePolicy ALLOW
  for the exact purpose/context
  AND all scopes are mutually compatible

DENY | unknown | expired | revoked | incompatible | unresolved => whole request DENY
```

Mixed ancestry is therefore not denied merely because it is mixed, but it fails closed if any contributing node is not independently authorized.

## Telegram consequence

Telegram ancestry triggers the Telegram branch of `SOURCE_POLICY.md` / ADR-012:

- personal TDLib/private-chat evidence: DENY by default unless applicable relevant-user scoped consent is provable;
- Bot/Mini-App/Business-chatbot evidence: potentially eligible only when the applicable disclosure/consent/authorization requirements are proven;
- broad historical indexing/training/benchmarking is not implied by a scoped inference permission.

## Security invariants

- provenance stripping/relabeling to obtain AI eligibility is forbidden;
- connector-supplied `ALLOW` claims are not authority;
- source content and AI output cannot create or broaden consent;
- generic Topic/Stream/Person objects cannot bypass the policy-authorized AI input builder;
- consent scope is non-transferable across chats/purposes unless the authoritative consent record explicitly says otherwise and current provider terms permit it.
