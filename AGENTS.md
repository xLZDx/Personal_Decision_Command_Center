# AGENTS.md — Personal Decision OS

Tool-agnostic conventions for any coding agent operating in this checkout — Claude Code, OpenAI
Codex/ChatGPT, Aider, or anything else. `CLAUDE.md` is the Claude Code entry point; this file is for
everyone else and for the rules that apply regardless of tool.

## What this is

Personal Decision OS: a personal work/knowledge/decision operating layer over exactly two MVP1
sources — Gmail and personal Telegram.

Architecture must be read in this order:

1. `docs/architecture/TDD_INVARIANT_AMENDMENTS.md` for adopted invariant changes;
2. `docs/architecture/TDD_ERRATA.md` for adopted non-invariant corrections;
3. frozen `docs/architecture/TDD.md` for everything not superseded;
4. adopted ADRs, where a newer ADR may explicitly supersede an older decision.

Do not re-derive architecture from historical/frozen text while ignoring a newer adopted amendment.

## Authority boundary — read this before writing any code

Any implementing agent here is **IMPLEMENTER, not final approver**. No agent has blanket
authorization to build the whole project. Authorization is gate-by-gate — see
`core/PLAN_MASTER_GATES.md` for the G0-G10 sequence and current state. An agent may inspect,
prepare evidence, write a gate plan and draft ADR text at any time; it implements a gate only
after that gate's own explicit operator/GPT-PM GO. Completion of one gate does not authorize the
next.

An implementing agent must never: self-approve a gate; merge on its own discretion; use production
deployment credentials; silently expand the MVP1 source scope (`core/MVP1_SCOPE_LOCK.md`); weaken
or delete a test to obtain green; mark a reviewer finding closed without evidence; edit
`governance/gate-manifests/**` or `governance/operator-approvals/**` outside their protected
operator-approved process; or submit source-derived values to AI without the current fail-closed
SourcePolicy + provenance authorization for the exact purpose/context.

Telegram is **not** a permanent source-name AI deny. Telegram AI is deny-by-default and may become
eligible only where the applicable ingress mode, context-bounded consent/authorization, provider
terms and provenance requirements in `core/adr/ADR-012-telegram-ai-context-policy.md` are proven.
Do not infer blanket permission from the existence of Telegram Bots, Mini Apps or Business
chatbots.

Merge to `main` is procedural, not mechanically exclusive to a human (`core/RISK_REGISTER.md` R13).
A Claude Code agent specifically may perform an ordinary merge only under `CLAUDE.md` §2's
GPT-PM-APPROVE-gated mechanism.

## Non-negotiable invariants

The invariants in frozen TDD §5 remain binding **as amended by**
`docs/architecture/TDD_INVARIANT_AMENDMENTS.md`. None may be changed without an ADR plus
independent review plus operator approval.

The shortcuts most likely to break the system:

- **Provenance must never be stripped to manufacture AI eligibility.** Telegram-derived values
  retain Telegram provenance (INV-04 retained). The AI boundary must use the policy-authorized
  input-builder model from amended INV-03/05/26 and ADR-012.
- **Mixed Gmail+Telegram state is not automatically blocked and not automatically allowed.** Every
  submitted source-derived ancestor must independently be current `AI_ALLOW` for the exact
  purpose/context; deny/unknown/expired/revoked/incompatible ancestry fails the whole AI call closed.
- **The Queue consumer is bound by the conservative Free-Worker CPU budget** (INV-27); see
  `core/adr/ADR-011-queue-consumer-runtime.md`.
- **A gate manifest edited by the implementer in the implementer's own branch has no authority**
  (INV-28).

## Build / test / run

See `core/PLAN_MASTER_GATES.md` for the authoritative current gate state. Real tooling includes
`npm run verify` (format, lint, typecheck, test), `npm run verify:mutation`, and
`npm run verify:secrets` where available for the active checkout/gate.

## Definition of Done

`core/DEFINITION_OF_DONE.md` plus each gate's own component DoD. A passing test suite alone never
closes a gate — check that each test would actually fail if the guarded behavior were removed.

## Review roles

Ten specialist review roles are defined and implemented as Claude-Code subagents in
`.claude/agents/` (`arch-01`, `sec-01`, `priv-01`, `data-01`, `rel-01`, `ai-01`, `qa-01`,
`ux-01`, `gov-01`, `red-01`). A non-Claude-Code agent fulfilling one of these roles should read the
matching file for its current checklist.

## Decision log

Record durable decisions (not routine narration) in `core/DECISION_LOG.md` as they happen.
