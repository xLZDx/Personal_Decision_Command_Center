---
name: pdos-gates
description: "Personal Decision OS's project-specific gate workflow (G0-G10, ten review roles, per-gate Definition of Done). Read this before starting, implementing, or closing any gate in this repository -- it layers on top of the global GO contract and rosetta, it does not replace either."
---

# Personal Decision OS — Gate Workflow

This project runs the global CLAUDE.md GO contract (`Plan -> GO -> Build -> Verify -> local Commit
-> Stop/report -> separate Push-GO -> Push`) and, where a Rosetta plan applies, its
`Plan -> GO -> Act -> Validate -> Document` phases — **plus** a project-specific gate layer defined
in `docs/architecture/TDD.md` §56-61 and the kickoff prompt
(`governance/reviews/00-claude-implementation-kickoff-v0.3.md`). Read `CLAUDE.md` in this repo
first; it is the short version of everything below.

## 1. Know which gate you are in

Check `core/PLAN_MASTER_GATES.md`. **Completion of one gate never authorizes the next** — this is
stricter than the general "continue to the next gate automatically" guidance in global CLAUDE.md
§17, because this project's own kickoff prompt says so explicitly ("Do not begin G1 work in the
same gate") and no operator instruction has widened that yet.

## 2. Claude is IMPLEMENTER, not final approver

See `CLAUDE.md` §2. You may inspect, prepare evidence, write a gate plan, and draft ADR text at
any time without a GO. You implement a gate only after that gate's own GO. You never self-approve
a gate, edit `governance/gate-manifests/**` or `governance/operator-approvals/**`, or mark a
reviewer finding closed without evidence.

## 3. Per-gate flow

```
Recon -> Plan -> Plan review -> GO -> Implementation -> Test/verification ->
Implementer self-check -> Independent review(s) -> Remediation -> Re-verification ->
Final verdict -> Closure report -> Operator merge/push
```

Write the plan into `governance/plans/<gate>_PLAN.md` (see `governance/plans/G0_PLAN.md` for the
shape). For G0 specifically, close with the exact `G0 PLAN REVIEW REQUEST` format from the
kickoff prompt.

## 4. Review roles

Ten roles exist as project-local subagents in `.claude/agents/`: `arch-01`, `sec-01`, `priv-01`,
`data-01`, `rel-01`, `ai-01`, `qa-01`, `ux-01`, `gov-01`, `red-01`. Select the minimal relevant
set for the gate's actual surface (global CLAUDE.md §6 still governs selection) — a Gmail-connector
gate needs `sec-01`/`priv-01`/`rel-01`/`data-01` at minimum, not necessarily `ux-01`. `gov-01` runs
at every gate's close. `red-01` runs only after every other selected role has already returned
APPROVE — it is the last check, not a parallel one.

Severity: `BLOCKER`/`MAJOR`/`MINOR`/`INFO`. ≥1 unresolved BLOCKER or MAJOR ⇒ REJECT. Implementer
cannot downgrade severity (`docs/architecture/TDD.md` §60).

## 5. Definition of Done

`core/DEFINITION_OF_DONE.md` (universal, 31 items) plus the gate's own component DoD in
`docs/architecture/TDD.md` §68-82. A green test suite alone never closes a gate — check that each
test would actually fail if the guarded behavior were removed before citing it as evidence.

## 6. The invariants that most often get silently violated by a shortcut

`docs/architecture/TDD.md` §5, INV-01..31. The three worth re-reading before touching AI,
Telegram, or the queue consumer specifically: INV-03/04/05/26 (no Telegram content or
Telegram-influenced assignment ever reaches AI, even via a combined-topic aggregate), INV-27 (the
Queue consumer is bound by the same ~10ms Free-Worker CPU budget as any Worker — see
`core/adr/ADR-011-queue-consumer-runtime.md`), INV-28 (a gate manifest an implementer edited in
their own branch has no authority).

## 7. Decision log

Record durable decisions (not routine narration) in `core/DECISION_LOG.md` as they happen — a
decision that exists only in chat history is not visible to the next session or to `red-01`/
`gov-01`.
