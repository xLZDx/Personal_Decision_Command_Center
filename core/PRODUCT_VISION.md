# Product Vision

Source: `docs/architecture/TDD.md` §0, §2.

Personal Decision OS is not another unified inbox. It is a personal work, knowledge and decision
operating layer. It continuously receives new communication events, normalizes them, associates
them with people/projects/streams/topics, tracks state and commitments, and presents one
prioritized list of decisions and actions regardless of originating channel.

```
NEW EVENTS -> SOURCE-SPECIFIC COLLECTORS -> NORMALIZED EVENT STREAM ->
IDENTITY / PROJECT / STREAM -> TOPIC / INTENT ->
KNOWLEDGE / DELIVERABLE / COMMITMENT / MILESTONE STATE -> DECISION / ACTION ->
DETERMINISTIC PRIORITY -> OPAQUE PUSH -> TODAY / DECISION CENTER ->
FULL SOURCE DRILL-DOWN ON DEMAND
```

Primary UX question: **"What needs my attention now?"** — not "Which inbox should I check?"

MVP1 proves this hypothesis with exactly two sources: Gmail and the operator's personal Telegram
account. See `MVP1_SCOPE_LOCK.md`.

Product goals (full list: TDD §2): near-real-time intake, one prioritized Today/Decisions/Actions
surface, cross-channel topic aggregation, person/project/stream state, commitments, minimal
milestones/ETA, centralized knowledge references, full evidence drill-down, opaque push, Android +
iPhone Home Screen PWA + Web, no required desktop client, hard-zero cost mode that fails closed.
