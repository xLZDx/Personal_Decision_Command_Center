# Telegram AI Policy Migration Checklist

**Purpose:** prevent the superseded v0.3 rule (`Telegram => permanent AI_DENY`, `GmailEvidenceBundle only`) from being accidentally reintroduced after adoption of ADR-012.

This document distinguishes **current live artifacts that must be aligned** from **historical/frozen evidence that should remain historically accurate**.

## New current authority

After adoption, current authority is:

1. `docs/architecture/TDD_INVARIANT_AMENDMENTS.md`
2. `core/adr/ADR-012-telegram-ai-context-policy.md`
3. `core/SOURCE_POLICY.md`
4. `docs/architecture/TDD_ERRATA.md` for non-invariant corrections
5. frozen TDD for non-superseded content

## Live docs aligned by the policy-reconciliation change

These must not state an unconditional Telegram AI prohibition:

- `README.md`
- `CLAUDE.md`
- `AGENTS.md`
- `CONTRIBUTING.md`
- `core/SOURCE_POLICY.md`
- `core/adr/ADR-004-normalized-event.md`
- `core/adr/ADR-005-value-provenance-dag.md`
- `core/adr/ADR-009-workers-ai-gmail-only.md` (marked partially superseded)
- `core/adr/ADR-012-telegram-ai-context-policy.md`
- `docs/architecture/TDD_ERRATA.md`
- `docs/architecture/TDD_INVARIANT_AMENDMENTS.md`
- `docs/architecture/EXTERNAL_ASSUMPTIONS.md`
- `docs/architecture/PROVENANCE_MODEL.md`
- `docs/architecture/THREAT_MODEL.md`
- `.claude/agents/ai-01.md`
- `.claude/agents/priv-01.md`
- `.claude/skills/pdos-gates/SKILL.md`

If another **live/current** document is discovered asserting any of the following as current policy, treat it as stale and reconcile it in the same reviewed change:

```text
Telegram raw/derived can never enter AI under any circumstance
Telegram provenance always means AI_DENY
MVP1 AI can only ever accept GmailEvidenceBundle
combined Gmail+Telegram state can never enter AI even when all contributors are policy-authorized
```

## Historical / frozen artifacts

Do not rewrite historical evidence merely to make history look consistent with current policy.

Examples include:

- frozen `docs/architecture/TDD.md` v0.3 baseline;
- `Personal_Decision_OS_v0.3_Implementation_Pack/Personal_Decision_OS_TDD_v0.3_FINAL.md`;
- old implementation kickoff/review artifacts;
- G0 closure/review reports;
- old decision-log entries describing what was true/approved at that time.

These are superseded **as current authority** by the invariant amendment / newer ADR where they discuss Telegram AI eligibility.

Entry-point docs must make that reading order explicit so a future agent does not use historical text as current policy.

## Runtime migration — NOT completed by documentation change

Current executable code still contains old-policy guards. Do not pretend otherwise.

Known examples at the policy-reconciliation starting point:

### `packages/contracts/src/event.ts`

Current behavior rejects a Telegram event when a routing hint claims `ai_policy: ALLOW`.

This is transitional old-policy enforcement.

Required future design:

- connector payload cannot self-authorize AI;
- normalized event keeps provenance/source-policy references;
- trusted policy code evaluates actual ingress mode/purpose/context/consent;
- source-name alone is not the final allow/deny decision.

Do not simply delete the guard and trust connector-provided `ALLOW`.

### `packages/contracts/tests/event.test.ts`

Old test asserts unconditional rejection of Telegram `AI_ALLOW` metadata.

Replace only in the separately authorized runtime migration with tests proving:

- connector-provided ALLOW is not authority;
- policy evaluator can allow an eligible scoped Telegram context;
- personal TDLib without required consent denies;
- unknown/expired/revoked/incompatible consent denies;
- provenance remains intact.

### provenance/policy tests

Search for tests whose expected rule is:

```text
any Telegram ancestor => BLOCKED
mixed ancestry => BLOCKED merely because Telegram is present
GmailEvidenceBundle is the only legal AI input forever
```

Rewrite only under the approved runtime policy-migration gate to the ADR-012 composition rule.

## Runtime target

The final runtime shape must have a trusted policy authorization step approximately equivalent to:

```text
PolicyAuthorizedAIContextBuilder.build(input, purpose, context)
```

Exact naming is not prescribed.

Required properties:

- every source-derived node retains provenance;
- no generic Topic/Stream/Person/source message bypass;
- consent/authorization is trusted application state, not source/model claims;
- authorization is checked immediately before the call;
- scope/revocation/expiry are enforced;
- mixed-source calls require every contributor to pass;
- one denied/unknown contributor denies the whole call;
- AI provider/model terms and quota checks remain separate gates.

## Search-based regression check

Before closing the runtime migration, search the entire repository for at least:

```text
GmailEvidenceBundle
Telegram-derived
Telegram raw
AI_DENY
never enters AI
Gmail-only
combined Gmail+Telegram
INV-03
INV-05
INV-26
```

Classify every hit as one of:

- CURRENT_AND_CORRECT
- HISTORICAL_SUPERSEDED
- RUNTIME_TO_MIGRATE
- STALE_BUG

Gate cannot close with an unexplained live `STALE_BUG` hit.

Do not mechanically delete historical records.

## Required policy cases

The new implementation must prove at least:

| Case | Expected |
| --- | --- |
| personal TDLib/private chat, no required scoped consent | DENY |
| unknown consent | DENY |
| expired/revoked consent | DENY |
| direct Bot/Mini-App context with valid applicable scoped consent | eligible for ALLOW |
| Business chatbot context missing required third-party/API authorization | DENY |
| consent from chat A used for chat B | DENY |
| consent for purpose A reused for purpose B | DENY |
| mixed Gmail + eligible Telegram, all contributors ALLOW | eligible for ALLOW |
| mixed request with one DENY/UNKNOWN contributor | DENY entire call |
| attempt to strip Telegram provenance | DENY / validation failure |

## Do not conflate policy reconciliation with feature enablement

Adopting ADR-012 corrects architecture policy.

It does **not** automatically turn on Telegram AI in production.

A concrete ingress mode becomes enabled only when its runtime consent/authorization/policy controls and tests are implemented and separately approved.
