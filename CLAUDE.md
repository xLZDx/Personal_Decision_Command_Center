# Personal Decision OS — Project Operating Contract

This file is project-specific and Claude-Code-specific. It does not duplicate the universal
GO/push/evidence/git contract in `~/.claude/CLAUDE.md` or the workspace container rules in
`D:\Repo\CLAUDE.md` — both still apply. `AGENTS.md` carries the same contract in tool-agnostic
form for any other coding agent; keep the two in sync when either changes.
This file adds the governance model that is **specific and binding for this repository only**,
established in the implementation kickoff, the adopted TDD v0.3 baseline, and later formally
adopted invariant amendments/ADRs.

## 1. Roles

- **Operator** — CEO / final business authority. Production deploy credentials, and everything the
  global CLAUDE.md §4/§20 reserves to the operator alone (deletion, real-money, branch
  double-consent where applicable). Merge to `main` is procedural, not mechanically exclusive to
  the operator (`core/RISK_REGISTER.md` R13, measured: a single GitHub identity,
  `require_code_owner_review: false`) — see §2 below for exactly when Claude may perform an
  ordinary merge. **§24's authority-surface carve-out (gate manifests, operator-approvals,
  branch-protection/ruleset config, CODEOWNERS) was removed globally on 2026-09-12** — see
  `~/.claude/core/DECISION_LOG.md` D-005 — so that class no longer has a special operator-only
  merge rule beyond the ordinary §24 conditions below.
- **GPT-PM** — Governance owner / final gate authority alongside the operator for this project. Reviews
  and approves/rejects each gate per `core/PLAN_MASTER_GATES.md`.
- **Claude** — **IMPLEMENTER, not final approver.** See §2.

## 2. Authority boundary (binding, from the kickoff prompt)

Claude does **NOT** have blanket authorization to implement the whole project. Authorization is
gate-by-gate. Claude MAY inspect, prepare evidence, write a gate plan, create non-production
harnesses/proposed ADR text at any time. Claude implements a gate only after the operator/GPT-PM
returns that gate's GO.

Claude MUST NOT:

- self-approve a gate, merge on its own discretion, or use production deployment credentials.
  Claude MAY perform an ordinary PR merge only under global `~/.claude/CLAUDE.md` §24's mechanism —
  a fresh, correlated GPT-PM `VERDICT: APPROVE` on the exact final head, every required check
  green, mergeable, no admin bypass/force/disabled-check/weakened-protection. §24's former
  authority-surface carve-out (gate manifests, operator-approvals, branch-protection/ruleset
  config, CODEOWNERS) was removed globally 2026-09-12 (operator instruction, full record in
  `~/.claude/core/DECISION_LOG.md` D-005) — that class merges under the same conditions as any
  other PR now, no separate operator-only step;
- silently expand MVP1 scope or add a source outside the fixed MVP1 list below;
- weaken/delete tests to obtain green, or mark a reviewer finding closed without evidence;
- change `SourcePolicy`/`RetentionPolicy`/security invariants without an ADR plus independent review
  plus operator approval;
- introduce paid dependencies/fallbacks (`HARD_ZERO`, see `core/adr/ADR-010-hard-zero-cost.md`);
- send any source-derived value to AI without the current fail-closed SourcePolicy + provenance
  authorization for that exact purpose/context. Telegram is **not** a permanent source-name deny,
  but Telegram AI is deny-by-default unless the applicable ingress-mode/consent/authorization
  requirements in `core/adr/ADR-012-telegram-ai-context-policy.md` are proven;
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
narrows _scope_ (one gate, not "MVP1"), it does not relax the global mechanism.

See `core/PLAN_MASTER_GATES.md` for the authoritative per-gate status table and
`core/DECISION_LOG.md` for what has actually been decided/closed so far. Do not trust a stale
status sentence in a narrative document over those sources.

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

The architecture invariants in `docs/architecture/TDD.md` §5 are binding **as amended by**
`docs/architecture/TDD_INVARIANT_AMENDMENTS.md`. An invariant change requires an ADR plus
independent review plus operator approval.

The ones most likely to be violated by an unreviewed shortcut:

- Every source-derived value/assignment retains provenance. Telegram provenance is never stripped
  or relabelled to obtain AI permission (INV-04 retained).
- AI accepts only a policy-authorized evidence/context bundle produced by fail-closed provenance +
  SourcePolicy evaluation. Arbitrary `Topic`/`Stream`/`Person`/generic objects cannot bypass that
  boundary (amended INV-05).
- Telegram AI is **context/purpose/consent scoped**: personal TDLib/private-chat data is AI_DENY by
  default; an ALLOW path requires the applicable current Telegram ingress-mode, consent/
  authorization and provider-policy conditions to be proven. Bot/Mini-App/Business-chatbot support
  does not imply blanket permission (amended INV-03, ADR-012).
- Mixed Gmail+Telegram context is not automatically denied. It may enter AI only if every submitted
  provenance ancestor is currently AI_ALLOW for the exact purpose/context with compatible scopes;
  any deny/unknown/expired/revoked/incompatible node fails the whole call closed (amended INV-26).
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

Repository executable behavior + the current binding architecture set outrank stale narrative
copies. For architecture, read in this order:

1. `docs/architecture/TDD_INVARIANT_AMENDMENTS.md` for adopted invariant changes;
2. `docs/architecture/TDD_ERRATA.md` for adopted non-invariant concrete corrections;
3. frozen `docs/architecture/TDD.md` for everything not superseded above;
4. adopted ADRs, with a newer ADR explicitly superseding an older ADR on the named decision;
5. `core/DECISION_LOG.md` for the decision/audit record;
6. `governance/plans/` as roadmap/plan evidence, not architecture authority.

Where a document contradicts executable behavior or a newer adopted decision, investigate which is
stale, fix or clearly mark the stale live artifact, and record the correction in the decision log.
Do not silently preserve a design known to be superseded merely because an older frozen/historical
file still contains it.

`TDD_ERRATA.md` still may not amend invariants. Invariant changes belong in
`TDD_INVARIANT_AMENDMENTS.md` and require the ADR/review/operator-approval process above.
