---
name: pdos-gates
description: "Personal Decision OS project-specific gate workflow (G0-G10, review roles, per-gate DoD). Read before starting, implementing, or closing a gate."
---

# Personal Decision OS — Gate Workflow

This project layers its gate model on top of the global GO/Rosetta contracts. Read repository `CLAUDE.md` first.

Architecture reading order is now:

1. `docs/architecture/TDD_INVARIANT_AMENDMENTS.md` for adopted invariant changes;
2. `docs/architecture/TDD_ERRATA.md` for adopted non-invariant corrections;
3. frozen `docs/architecture/TDD.md` for everything not superseded;
4. adopted ADRs, where newer ADRs may explicitly supersede older decisions.

Do not resurrect a frozen/historical policy statement when a current amendment supersedes it.

## 1. Know which gate you are in

Check `core/PLAN_MASTER_GATES.md`. Completion of one gate never authorizes the next.

## 2. Implementer is not final approver

You may inspect, prepare evidence, write a gate plan and draft ADR text without GO. Implement only after that gate's explicit GO. Never self-approve or bypass protected governance state.

## 3. Per-gate flow

```text
Recon -> Plan -> Plan review -> GO -> Implementation -> Test/verification ->
Implementer self-check -> Independent review(s) -> Remediation -> Re-verification ->
Final verdict -> Closure report -> merge/push under the active authority rules
```

## 4. Review roles

Project roles: `arch-01`, `sec-01`, `priv-01`, `data-01`, `rel-01`, `ai-01`, `qa-01`, `ux-01`, `gov-01`, `red-01`.

Select the minimum relevant set. `gov-01` participates at gate close; `red-01` is the final adversarial sweep after other selected roles approve.

Severity: `BLOCKER` / `MAJOR` / `MINOR` / `INFO`. Any unresolved BLOCKER/MAJOR rejects the gate.

## 5. Definition of Done

Use `core/DEFINITION_OF_DONE.md` plus the active gate's DoD. Green tests alone do not close a gate; cited tests must actually fail when the guarded behavior is removed.

## 6. Invariants most likely to be violated by shortcuts

- Source-derived values/assignments retain provenance. Do not strip Telegram provenance to manufacture AI permission.
- AI input must pass fail-closed SourcePolicy + provenance authorization for the exact purpose/context. Telegram is **deny-by-default but not permanently denied by source name**; see ADR-012 and the invariant amendments.
- Mixed Gmail+Telegram context is permitted only when every submitted source-derived ancestor is current ALLOW for the same purpose/context; any deny/unknown/expired/revoked/incompatible node denies the whole call.
- The conservative Queue consumer CPU rule remains binding under INV-27/ADR-011.
- A gate manifest edited outside its protected adoption/amendment process has no authority (INV-28).

## 7. Decision log

Record durable decisions in `core/DECISION_LOG.md`. A decision that exists only in chat history is not visible to future reviewers.
