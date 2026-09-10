# Personal Decision OS

A personal work, knowledge and decision operating layer — not another unified inbox. It collects
new events from Gmail and personal Telegram, normalizes and associates them with
people/projects/streams/topics, tracks commitments and decisions, and shows one prioritized
"what needs my attention now" surface with full evidence drill-down.

Full architecture: [`docs/architecture/TDD.md`](docs/architecture/TDD.md) (binding baseline,
v0.3 FINAL). Project governance contract for Claude Code sessions: [`CLAUDE.md`](CLAUDE.md).
Current status and gate plan: [`core/PLAN_MASTER_GATES.md`](core/PLAN_MASTER_GATES.md).

## Status

**G0 in progress** (implementation-readiness verification + ADR freeze). No connector, service, or
PWA code exists yet — that begins at G1+, each gate individually authorized. See
[`core/DECISION_LOG.md`](core/DECISION_LOG.md) for what has actually been decided.

## Scope (MVP1)

Exactly two sources: Gmail + personal Telegram. See
[`core/MVP1_SCOPE_LOCK.md`](core/MVP1_SCOPE_LOCK.md) — this is a hard boundary, not a starting
point to expand from casually.

## Repository layout

```
core/            product/scope/gate/decision/risk/policy/DoD governance docs + ADRs
docs/            architecture (TDD, data model, provenance, threat model, connectors, observability),
                 product (MVP1, post-MVP, user flows), runbooks
apps/pwa/        the PWA client (empty — G7)
services/        api, ingest, processor, resolver, decision, notification, reporting,
                 content-request-broker (empty — G2+)
connectors/      gmail, telegram-tdlib (empty — G3/G4)
host/            content-gateway, backup-agent, optional-http-pull-consumer (empty — G4/G8)
packages/        contracts, domain, policy, provenance, telemetry, testkit (empty — G1+)
infra/           cloudflare, connector-host, migrations (empty — G1+)
tests/           unit, contract, integration, e2e, policy, security, resilience, quota, fixtures
governance/      plans, reviews, gate-manifests (operator-owned), operator-approvals (operator-owned)
scripts/         verify, quota, probes, backup, restore, ops
.claude/agents/  the ten review roles (arch-01 .. red-01)
.claude/skills/  project-local gate workflow skill
```
