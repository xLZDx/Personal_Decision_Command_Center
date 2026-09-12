# AGENTS.md — Personal Decision OS

Tool-agnostic conventions for any coding agent operating in this checkout — Claude Code, OpenAI
Codex/ChatGPT, Aider, or anything else. `CLAUDE.md` is the Claude Code entry point (Claude-Code-
specific: subagent routing via `.claude/agents/`, skill loading, the global CLAUDE.md GO contract
by name); this file is for everyone else, and for the parts that apply regardless of which agent
is reading them.

## What this is

Personal Decision OS: a personal work/knowledge/decision operating layer over exactly two sources
— Gmail and personal Telegram. Full architecture: `docs/architecture/TDD.md` (binding baseline,
v0.3 FINAL). Do not re-derive the architecture from scratch; read that file first.

Read `docs/architecture/TDD_ERRATA.md` alongside it. The TDD is frozen and cannot self-correct, so
corrections to concrete details — paths, file names, figures — live there and **outrank the TDD**.
It never amends the invariants.

## Authority boundary — read this before writing any code

Any implementing agent here is **IMPLEMENTER, not final approver**. No agent has blanket
authorization to build the whole project. Authorization is gate-by-gate — see
`core/PLAN_MASTER_GATES.md` for the G0-G10 sequence and its current state. An agent may inspect,
prepare evidence, write a gate plan, and draft ADR text at any time; it implements a gate only
after that gate's own explicit operator/GPT-PM GO. Completion of one gate does not authorize the
next.

An implementing agent must never: self-approve a gate; merge on its own discretion; use production
deployment credentials; silently expand the MVP1 source scope (`core/MVP1_SCOPE_LOCK.md`); weaken
or delete a test to obtain green; mark a reviewer finding closed without evidence; edit
`governance/gate-manifests/**` or `governance/operator-approvals/**` (operator-owned protected
paths); send Telegram-derived content or state to any AI call, in any form. Merge to `main` is
procedural, not mechanically exclusive to a human (`core/RISK_REGISTER.md` R13: one GitHub
identity, `require_code_owner_review: false`) — a Claude Code agent specifically may perform an
ordinary merge only under `CLAUDE.md` §2's GPT-PM-APPROVE-gated mechanism. That mechanism's former
authority-surface carve-out (gate manifests, operator-approvals, branch-protection/ruleset config,
CODEOWNERS) was removed globally 2026-09-12 — see `~/.claude/core/DECISION_LOG.md` D-005 — so that
class merges under the same conditions as any other PR, no separate operator-only step.

## Non-negotiable invariants

`docs/architecture/TDD.md` §5 lists 31 (INV-01..INV-31). None may be changed without an ADR plus
independent review plus operator approval. The three most likely to be violated by a shortcut:

- **No Telegram content or Telegram-influenced state ever reaches AI** (INV-03/04/05/26) — not
  the raw text, not a derived enum/date/count, not a combined-topic aggregate. MVP1 AI accepts
  exactly one input type, `GmailEvidenceBundle`, built before cross-channel merge. See
  `core/adr/ADR-005-value-provenance-dag.md`.
- **The Queue consumer is bound by the same ~10ms Free-Worker CPU budget as any other Worker
  invocation** (INV-27) — do not design a "heavy" consumer and hope the Free-plan docs' 30s/5min
  figure applies; that figure is Paid-plan. See `core/adr/ADR-011-queue-consumer-runtime.md`.
- **A gate manifest edited by the implementer in the implementer's own branch has no authority**
  (INV-28).

## Build / test / run

G0 closed 2026-09-10; G1 (toolchain, CI, governance enforcement) is remediated and its closure
findings are being resolved — see `core/PLAN_MASTER_GATES.md` for the authoritative current state,
which changes faster than this file. Real tooling exists as of G1: `npm run verify` (format, lint,
typecheck, test — the required composite), `npm run verify:mutation` (the mutation-testing harness
for governance-critical checks), `npm run verify:secrets`. Service/connector/PWA code itself still
does not exist; that begins at G2+.

## Definition of Done

`core/DEFINITION_OF_DONE.md` (31 universal items) plus each gate's own component DoD in
`docs/architecture/TDD.md` §68-82. A passing test suite alone never closes a gate — check that
each test would actually fail if the guarded behavior were removed.

## Review roles

Ten specialist review roles are defined in `docs/architecture/TDD.md` §59 and implemented as
Claude-Code subagents in `.claude/agents/` (`arch-01`, `sec-01`, `priv-01`, `data-01`, `rel-01`,
`ai-01`, `qa-01`, `ux-01`, `gov-01`, `red-01`). A non-Claude-Code agent fulfilling one of these
roles should read the matching `.claude/agents/<role>.md` file for its actual checklist — the
role definitions are tool-agnostic even though the invocation mechanism is Claude-Code-specific.

## Decision log

Record durable decisions (not routine narration) in `core/DECISION_LOG.md` as they happen.
