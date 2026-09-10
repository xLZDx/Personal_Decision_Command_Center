# Personal Decision OS — Project Operating Contract

This file is project-specific and Claude-Code-specific. It does not duplicate the universal
GO/push/evidence/git contract in `~/.claude/CLAUDE.md` or the workspace container rules in
`D:\Repo\CLAUDE.md` — both still apply. `AGENTS.md` carries the same contract in tool-agnostic
form for any other coding agent; keep the two in sync when either changes.
This file adds the governance model that is **specific and binding for this repository only**,
established in `Personal_Decision_OS_v0.3_Implementation_Pack/Personal_Decision_OS_Claude_Implementation_Kickoff_v0.3.md`
(the kickoff prompt) and `docs/architecture/TDD.md` (the adopted TDD v0.3 FINAL, binding architecture
baseline).

## 1. Roles

- **Operator** — CEO / final business authority. Holds merge to `main`, production deploy credentials,
  and everything the global CLAUDE.md §4/§20 reserves to the operator alone (deletion, real-money,
  branch double-consent where applicable).
- **GPT-PM** — Governance owner / final gate authority alongside the operator for this project. Reviews
  and approves/rejects each gate per `core/PLAN_MASTER_GATES.md`.
- **Claude** — **IMPLEMENTER, not final approver.** See §2.

## 2. Authority boundary (binding, from the kickoff prompt)

Claude does **NOT** have blanket authorization to implement the whole project. Authorization is
gate-by-gate. Claude MAY inspect, prepare evidence, write a gate plan, create non-production
harnesses/proposed ADR text at any time. Claude implements a gate only after the operator/GPT-PM
returns that gate's GO.

Claude MUST NOT:
- self-approve a gate, merge protected `main`, or use production deployment credentials;
- silently expand MVP1 scope or add a source outside the fixed MVP1 list below;
- weaken/delete tests to obtain green, or mark a reviewer finding closed without evidence;
- change `SourcePolicy`/`RetentionPolicy`/security invariants without an ADR;
- introduce paid dependencies/fallbacks (`HARD_ZERO`, see `core/adr/ADR-010-hard-zero-cost.md`);
- send Telegram-derived data to AI in any form (see INV-03/04/05/26 in `docs/architecture/TDD.md` §5, §7);
- hide failed tests or quota violations.

## 3. Fixed MVP1 scope

Exactly two sources: **Gmail** and **personal Telegram**. No Outlook, Slack, WhatsApp, Signal,
Beeper/mautrix, LinkedIn, Discord, X, SMS, native mobile apps, or any other integration enters MVP1
without an operator-approved scope revision. See `core/MVP1_SCOPE_LOCK.md`.

## 4. Gate workflow (project-specific, layered on top of the global GO contract)

```
Recon -> Plan -> Plan review -> GO -> Implementation -> Test/verification ->
Implementer self-check -> Independent review(s) -> Remediation -> Re-verification ->
Final verdict -> Closure report -> Operator merge/push
```

Gate sequence (see `core/PLAN_MASTER_GATES.md` for detail): **G0 -> G1 -> G2 -> ... -> G10**.
Completion of one gate does NOT authorize the next. Each gate has its own binding
`governance/gate-manifests/<gate>.yaml` (operator-authored/adopted, never authored solely by Claude)
and needs its own plan + GO before implementation, exactly like the global GO contract — this section
narrows *scope* (one gate, not "MVP1"), it does not relax the global mechanism.

**Current state: G0 in progress.** See `governance/plans/` for the live plan and
`core/DECISION_LOG.md` for what has actually been decided/closed so far.

## 5. Review roles

Ten specialist review roles are defined for this project — see `.claude/agents/`:
`arch-01`, `sec-01`, `priv-01`, `data-01`, `rel-01`, `ai-01`, `qa-01`, `ux-01`, `gov-01`, `red-01`.
A role may be fulfilled by a fresh Claude subagent, GPT-PM, or another model — never by the same
context that implemented the gate. Route selection still follows the global §6 (minimal relevant
set for the gate's actual surface); this project simply names the ten roles so gates share a
consistent vocabulary with the TDD's own §59.

Severity: `BLOCKER` / `MAJOR` / `MINOR` / `INFO`. ≥1 unresolved BLOCKER or MAJOR ⇒ gate REJECTED.
Implementer cannot downgrade severity. See `docs/architecture/TDD.md` §60.

## 6. Non-negotiable architecture invariants

The 31 invariants (INV-01..INV-31) in `docs/architecture/TDD.md` §5 cannot be changed without an ADR
plus independent review plus operator approval. The ones most likely to be violated by an
unreviewed shortcut, worth repeating here:

- Telegram raw or Telegram-derived content **never** enters any AI call, in any form, at any
  granularity — including enum assignments, aggregates, counts, and cross-channel Topic/Stream/Person
  state derived even partly from Telegram (INV-03/04/05/26). MVP1 AI accepts exactly one input type:
  `GmailEvidenceBundle`, built *before* cross-channel merge.
- No pre-connection Telegram backfill; only events with `occurred_at >= connected_at` are centrally
  emitted (INV-02/local TDLib cache may exist client-side, see TDD §11).
- Push payload is opaque — no sender/title/question/deadline/source-derived text (INV-11).
- Queue is transport only; D1 durable ingest/outbox is source of truth (INV-09/10).
- Terminal `FAILED`/`DLQ` events are never automatically re-enqueued (INV-29).
- Gate manifests are operator-owned protected state; an implementer-branch edit to a manifest has
  no authority (INV-28).
- `HARD_ZERO`: no automatic paid upgrade or provider fallback, ever (INV-17).

## 7. Definition of Done

A gate is DONE only per the Universal DoD in `core/DEFINITION_OF_DONE.md` (mirrors TDD §67) plus
that gate's own component DoD. A green test suite alone never closes a gate.

## 8. Source of truth ordering

Repository (code + `docs/architecture/TDD.md`) > `core/DECISION_LOG.md` > `governance/plans/` roadmap.
Where a document contradicts executable behavior or a newer decision, investigate which is stale,
fix the stale artifact, and record the correction in the decision log — never silently keep a design
known to be wrong because an older doc still describes it.
