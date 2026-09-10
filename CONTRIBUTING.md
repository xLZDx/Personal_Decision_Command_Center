# Contributing

This is a personal, single-operator project — "contributing" here means working a gate as the
implementer (Claude Code or otherwise), not external open-source contribution.

1. Read [`CLAUDE.md`](CLAUDE.md) and the current gate's entry in
   [`core/PLAN_MASTER_GATES.md`](core/PLAN_MASTER_GATES.md).
2. Do not implement a gate without its own plan + GO — see `CLAUDE.md` §4 and the global GO
   contract it references.
3. Do not touch `governance/gate-manifests/**` or `governance/operator-approvals/**` — those are
   operator-owned protected paths.
4. Every behavior change needs a test; every failure/recovery path needs a test that would
   actually fail if the guard were removed (`CLAUDE.md` §7).
5. Never send Telegram-derived content or state to AI, in any form — see
   [`core/SOURCE_POLICY.md`](core/SOURCE_POLICY.md) and
   [`core/adr/ADR-005-value-provenance-dag.md`](core/adr/ADR-005-value-provenance-dag.md).
6. Record durable decisions in [`core/DECISION_LOG.md`](core/DECISION_LOG.md), not only in a PR
   description or chat transcript.
