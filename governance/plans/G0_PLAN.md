# G0 Plan

**Plan ID:** `pdos-g0-2026-09-10`
**Repository:** `D:\Repo\Personal_Decision_Command_Center`
**Scope:** Implementation-readiness verification + ADR freeze, per
`../reviews/00-claude-implementation-kickoff-v0.3.md`, G0 required outputs A-O.

## Status: CLOSED

**GPT-PM VERDICT: APPROVE, 0 BLOCKER / 0 MAJOR (2026-09-10).** Full closure record, including
the approval-anchor discrepancy and the items carried into G2 as blocking preflight, is in
`../G0_CLOSURE_REPORT.md`. The table below is the final state, not a live worklist.

## Status of this plan

| Step | Item                                                                                                          | Status                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Repository scaffold (directory tree, `CLAUDE.md`, `core/*`, ADR drafts, `.claude/agents/`, `.claude/skills/`) | **DONE** — this commit                                                                                                                      |
| 2    | A. Adopt/freeze TDD v0.3 in repo                                                                              | **DONE** — `docs/architecture/TDD.md`                                                                                                       |
| 3    | B. Live Telegram API/Content Licensing terms snapshot                                                         | DONE — `docs/architecture/EXTERNAL_ASSUMPTIONS.md` B                                                                                        |
| 4    | C. Live Cloudflare Workers/Queues/D1/Analytics/Tunnel/Workers-AI snapshot                                     | DONE — `EXTERNAL_ASSUMPTIONS.md` C (contradiction found to be three-way)                                                                    |
| 5    | D. Live Gmail watch/history assumptions snapshot                                                              | DONE — `EXTERNAL_ASSUMPTIONS.md` D (billing question unresolved by docs, experiment recorded)                                               |
| 6    | E. Empirical Cloudflare Free CPU smoke harness + operator-run instructions                                    | **HARNESS DONE, NOT RUN** — needs an operator Cloudflare Free account; closed unrun by GPT-PM ruling, carried to G2 as `G2-PREFLIGHT-01/02` |
| 7    | F-M. ADR-002/003/005/007/008/009/010/011                                                                      | ADOPTED — all eight ADRs; ADR-011 is ADOPTED WITH R8/R9 OPEN                                                                                |
| 8    | N. Threat model update                                                                                        | REVIEWED AND ADOPTED — GPT-PM fresh-context SEC/PRIV review, no new BLOCKER/MAJOR                                                           |
| 9    | O. Binding gate-manifest integrity mechanism design                                                           | DONE — `../GATE_MANIFEST_INTEGRITY.md` (design; implementation is G1)                                                                       |
| 10   | Submit `G0 PLAN REVIEW REQUEST` for independent review before G1                                              | DONE — submitted and answered; G0 APPROVED, G1 held (see `G1_REMEDIATION_PLAN.md`)                                                          |

## Files created/changed (step 1-2, this commit)

Full new-repo scaffold: `CLAUDE.md`, `.gitignore`, `README.md`, `SECURITY.md`, `CONTRIBUTING.md`,
`core/*` (8 governance docs + 11 ADR files), `docs/architecture/*` (TDD adoption + 4 index/model
docs + threat model draft), `docs/product/*` (3 files), `docs/runbooks/*` (9 placeholder
runbooks), `governance/reviews/*` (3 copied source documents), `governance/plans/G0_PLAN.md`
(this file), `.claude/agents/*` (10 review-role subagent definitions), `.claude/skills/pdos-gates/`
(project gate-workflow skill). Empty directories for `apps/`, `services/`, `connectors/`, `host/`,
`packages/`, `infra/`, `tests/`, `scripts/` created but intentionally left without code — that is
G1+ scope.

## External assumptions to verify (steps 3-6)

Telegram API Terms + Content Licensing (current text, not a cached memory of it); Cloudflare
Workers Free CPU limits (10ms table) vs. Queues consumer CPU documentation (the NB1 ambiguity);
Cloudflare D1 Free limits (5M reads/day, 100K writes/day, 500MB/DB, 5GB account, 7-day Time
Travel, hard enforcement since 2026-09-01); Cloudflare Queues Free (10K ops/day, 24h retention,
HTTP pull consumer support); Workers Analytics Engine Free (100K datapoints/day, 10K read
queries/day — MIN-5, previously unconfirmed independently); Cloudflare Tunnel (outbound-only, all
plans); Gmail `users.watch`/`history.list` semantics and renewal requirement; iOS 16.4+ Web Push
on Home Screen PWA.

## Commands/tests (this commit)

```
git status / git log   — verify scaffold committed cleanly, no stray files
```

No code exists yet, so no build/lint/test commands apply to steps 1-2. Steps 3-6/9 will add
`scripts/probes/free-tier-snapshot/` (fetch + record live values) and
`scripts/probes/cloudflare-free-cpu/` (empirical CPU harness + reproducible operator instructions).

## Security/privacy checks

None triggered by steps 1-2 — no credentials, no code touching Telegram/Gmail data. Step 3 (live
Telegram terms re-check) is itself the security/privacy-relevant step for this plan; see
`core/SOURCE_POLICY.md`.

## Governance checks

`governance/gate-manifests/` and `governance/operator-approvals/` are left with README stubs only
— no manifest was authored by Claude, per NM3's closure (`core/RISK_REGISTER.md`) and
`CLAUDE.md` §2/§6. The operator/GPT-PM authors or adopts the actual G0 gate manifest.

## Expected evidence at G0 closure

Live-fetched snapshots (steps 3-5) with source URLs and fetch dates; CPU probe results or, if
credentials are unavailable, the probe script plus exact reproducible instructions (never
fabricated numbers); the 8 ADRs moved from DRAFT to ADOPTED after independent review; threat model
reviewed by `sec-01`/`priv-01`; gate-manifest integrity mechanism design document; the final
`G0 PLAN REVIEW REQUEST`.

## Explicit non-scope

No G1+ work: no CI, no D1 schema/migrations, no connector code, no PWA code, no actual Cloudflare
deployment. No production credentials are used or requested.

## Risks/open questions

- Whether the empirical CPU probe (item E) can actually run against a real Cloudflare Free
  account depends on the operator providing/creating one — flagged, not assumed.
- The TDD/review documents in `Personal_Decision_OS_v0.3_Implementation_Pack/` and now
  `docs/architecture/TDD.md`/`governance/reviews/` carry a pre-existing encoding defect (mojibake
  in ASCII-art arrows and in one review's Cyrillic prose) — see `core/DECISION_LOG.md` entry
  2026-09-10. Cosmetic, not blocking, but worth an explicit operator decision before touching the
  "frozen" TDD text to fix it.
- This project has no registered PM Bridge / GPT-PM conversation mapping yet
  (`D:\Repo\pm-bridge\config\conversations.md` has no entry for this repo). The TDD's own
  governance model names GPT-PM as a final gate authority alongside the operator — registering a
  conversation (or confirming which existing one already carries this design's review history) is
  needed before a mechanical GPT-PM review round can target the right context.
