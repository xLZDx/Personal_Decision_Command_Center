# Personal Decision OS

A personal work, knowledge and decision operating layer — not another unified inbox. It collects
new events from Gmail and personal Telegram, normalizes and associates them with
people/projects/streams/topics, tracks commitments and decisions, and shows one prioritized
"what needs my attention now" surface with full evidence drill-down.

## Architecture reading order

The frozen v0.3 TDD is the historical baseline, but it is no longer sufficient by itself.
Read current architecture in this order:

1. [`docs/architecture/TDD_INVARIANT_AMENDMENTS.md`](docs/architecture/TDD_INVARIANT_AMENDMENTS.md)
   — adopted invariant changes, including the current Telegram AI policy;
2. [`docs/architecture/TDD_ERRATA.md`](docs/architecture/TDD_ERRATA.md)
   — normative non-invariant corrections;
3. [`docs/architecture/TDD.md`](docs/architecture/TDD.md)
   — frozen v0.3 baseline for everything not superseded;
4. current ADRs under [`core/adr/`](core/adr/), where a newer ADR may explicitly supersede an older decision.

**Important:** v0.3's absolute "Telegram-derived data never enters AI / Gmail-only AI forever" wording is historical and superseded by
[`ADR-012`](core/adr/ADR-012-telegram-ai-context-policy.md) plus the invariant amendments. Current
policy is fail-closed and context/purpose/consent scoped, not source-name-only.

Project governance contract for Claude Code sessions: [`CLAUDE.md`](CLAUDE.md); tool-agnostic
version: [`AGENTS.md`](AGENTS.md). Current gate state: [`core/PLAN_MASTER_GATES.md`](core/PLAN_MASTER_GATES.md).

## Scope (MVP1)

Exactly two implemented MVP1 sources: Gmail + personal Telegram. See
[`core/MVP1_SCOPE_LOCK.md`](core/MVP1_SCOPE_LOCK.md). This implementation-scope limit is separate
from source policy: a Telegram source may be AI_DENY or policy-eligible depending on the exact
ingress mode/context/consent rules; source count and AI eligibility are different concerns.

## Repository layout

```text
CLAUDE.md        Claude Code entry point / project governance contract
AGENTS.md        tool-agnostic operating contract
core/            product/scope/gate/decision/risk/policy/DoD docs + ADRs
docs/            architecture, product and runbooks
apps/pwa/        PWA client
services/        api, ingest, processor, resolver, decision, notification, reporting, content broker
connectors/      source connectors
host/            connector-host services/content gateway/backup helpers
packages/        contracts, domain, policy, provenance, telemetry, testkit
infra/           cloud/platform/migrations
 tests/           unit/contract/integration/e2e/policy/security/resilience/quota fixtures
governance/      plans, reviews, gate manifests, approvals
scripts/         verification/quota/probes/backup/restore/ops
.claude/agents/  specialist review roles
.claude/skills/  project-local skills
```
