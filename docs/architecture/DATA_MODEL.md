# Data Model

Canonical source: `docs/architecture/TDD.md` §34 (D1 table list), §35 (D1 design/quota budget),
§8 (canonical state vs. display projections), §13 (normalized event contract), §19 (identity
graph), §26-31 (decision/commitment/milestone/knowledge/priority/proactive-alert models).

This file is an index, not a duplicate — the TDD is the frozen baseline (`CLAUDE.md` §8 source-of-
truth ordering). It gets expanded into real migrations/schema at G2, at which point this file
should start carrying the actual entity-relationship detail and diverge from being a pointer.

## Minimum D1 tables (TDD §34)

```
users, devices
source_accounts, source_policies, source_cursors
ingest_events, processing_outbox, processing_attempts, dead_letter_events
people, identities
projects, streams, topics, topic_events, topic_merge_events
intents, decisions, decision_evidence, commitments, milestones, knowledge_items, deliverables
notifications, snoozes
ai_runs, policy_decisions
audit_events, backup_runs, retention_runs
```

Content-bearing fields must use provenance-aware wrappers or equivalent normalized provenance
tables (see `PROVENANCE_MODEL.md`) — plain untracked free-text domain columns are forbidden for
source-derived values.

## D1 Free-tier hard constraints (re-verify live at G0/G2 — see `../../governance/plans/`)

```
5M rows read/day, 100K rows written/day, 500MB per Free database, 5GB total account storage,
7-day Time Travel. Beginning 2026-09-01, exceeding daily read/write limits fails queries until
reset.
```
