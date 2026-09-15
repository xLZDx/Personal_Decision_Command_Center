# Contributing

This is a personal, single-operator project — "contributing" here means working a gate as the
implementer (Claude Code or otherwise), not external open-source contribution.

1. Read [`CLAUDE.md`](CLAUDE.md),
   [`docs/architecture/TDD_INVARIANT_AMENDMENTS.md`](docs/architecture/TDD_INVARIANT_AMENDMENTS.md),
   and the current gate's entry in [`core/PLAN_MASTER_GATES.md`](core/PLAN_MASTER_GATES.md).
2. Do not implement a gate without its own plan + GO — see `CLAUDE.md` and the global GO contract
   it references.
3. Do not touch `governance/gate-manifests/**` or `governance/operator-approvals/**` outside their
   protected operator-approved governance flow.
4. Every behavior change needs a test; every failure/recovery path needs a test that would actually
   fail if the guard were removed.
5. Never send source-derived content/state to AI by a source-name shortcut. AI input must pass the
   current fail-closed SourcePolicy + provenance evaluation for the exact purpose/context. Telegram
   is deny-by-default, not permanently denied by source name; see
   [`core/SOURCE_POLICY.md`](core/SOURCE_POLICY.md) and
   [`core/adr/ADR-012-telegram-ai-context-policy.md`](core/adr/ADR-012-telegram-ai-context-policy.md).
6. Never strip/relabel provenance, fabricate consent, or broaden consent scope to make an AI call
   pass policy.
7. Record durable decisions in [`core/DECISION_LOG.md`](core/DECISION_LOG.md), not only in a PR
   description or chat transcript.
