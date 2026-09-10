# G1 Remediation Plan

**Plan ID:** `pdos-g1-remediation-2026-09-10`
**Gate:** G1 — Repository + governance enforcement + CI + contracts
**Status:** OPEN, awaiting operator decisions on steps 1-2 (see "Blocked on the operator")
**Supersedes:** nothing. Commit `b784265` is **bootstrap implementation, not gate-approved work**.

## Why this plan exists

GPT-PM reviewed G1 and returned **REJECT/HOLD** with two BLOCKERs and three MAJORs. The findings
are accepted; none of them is disputed. Summarised, with what verification found:

| ID    | Finding                                                                                                                                                                                             | Verified?                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| G1-B1 | G1 was implemented with no G1 plan, no manifest, no GO, and before G0 closure — violating this repo's own gate contract                                                                             | **Confirmed.** `governance/plans/` held only `G0_PLAN.md` while G1 code landed in `b784265` |
| G1-B2 | Remote CI is red; "local verify green" is not gate evidence                                                                                                                                         | **Confirmed, and the root cause is worse than a code failure** — see below                  |
| G1-M1 | The PR-based controls are bypassed by the direct-to-`main` path actually in use                                                                                                                     | **Confirmed** — `gate-scope.yml`/`policy-integrity.yml` are `pull_request` workflows        |
| G1-M2 | Implementation diverges from `GATE_MANIFEST_INTEGRITY.md`: the design says the scope check runs only after the hash check, in the same job; the code has two independent workflows with `needs: []` | **Confirmed**                                                                               |
| G1-M3 | Protected-main model unproven; branch protection on a **private** repo needs a paid GitHub plan; and CODEOWNERS self-approval deadlocks if Claude pushes as the operator                            | **Confirmed in part** — `/branches/main/protection` returns 404, repo is `private: true`    |

### G1-B2 root cause — not a code failure at all

The CI run for `b784265` (`34513131209`, job `102991918020`) completed in **4 seconds with zero
steps executed**. GitHub's own check-run annotation:

> "The job was not started because recent account payments have failed or your spending limit
> needs to be increased. Please check the 'Billing & plans' section in your settings"

So every claim of the form "CI enforces X" in this repository is currently false — not because a
check fails, but because no check runs. Recorded as `R11` in `../core/RISK_REGISTER.md`.

## Blocked on the operator (nothing else can be verified until these are settled)

1. **R11 — GitHub Actions billing.** Billing/spending limits are account settings and are outside
   the implementer's authority entirely (global operating contract §4).
2. **R12 — the enforcement model.** Branch protection/rulesets on a private repository require a
   paid GitHub plan; this repo is private and has no protection configured. Three options, and the
   choice is the operator's:
   - fix billing and pay for a plan that allows protection on a private repo — conflicts with
     HARD_ZERO's spirit, though HARD_ZERO is scoped to _infrastructure_ cost, not tooling;
   - **make the repository public** — Actions are free and unmetered for public repos, and
     branch protection is available on Free for public repos, so this closes R11 and R12 together
     at zero cost. Cost: the code and governance docs become world-readable. The secret scan found
     nothing across 70 tracked files, and the repo contains architecture, not the operator's
     personal data — but publishing is an operator-only call;
   - accept that no mechanical enforcement exists, and record it as an explicit accepted risk
     rather than leaving documents claiming a control that is not there.
3. **R13 — implementer identity.** If Claude pushes under the operator's own GitHub identity, then
   PR author = code owner = required approver, and GitHub forbids self-approval, so the model
   deadlocks. Either provision a separate implementation identity, or stop claiming CODEOWNERS
   mechanically separates implementer from operator and rely on the operator-held approval hash
   plus GPT-PM's gate verdict instead.

## Sequence (GPT-PM's ordering, adopted)

```
1. G0 administrative closure                                    DONE (../G0_CLOSURE_REPORT.md)
2. Operator settles R11/R12/R13                                 BLOCKED ON OPERATOR
3. G1 plan reviewed and GO given                                pending
4. Operator authors/adopts governance/gate-manifests/g1.yaml    pending (operator-only, INV-28)
5. Operator sets GATE_MANIFEST_APPROVED_HASH_G1 repo variable   pending (operator-only, out of tree)
6. Create branch gate/g1-remediation                            AUTHORIZED by GPT-PM APPROVE
7. Fix G1-M2: one governance workflow, hash-check -> scope-check pending
8. Confirm CI actually runs and is green on that branch          blocked on step 2
9. Negative-control PR tests (see below)                         blocked on steps 2, 4, 5
10. Fresh-context G1 review                                      pending
11. G1 closure report                                            pending
```

Step 6's branch is authorized: GPT-PM returned an explicit APPROVE for "option (a)", naming
`gate/g1-remediation`, which under the global operating contract §20 is sufficient authorization
for branch creation. Subsequent `gate/gN-*` branches each still need their own gate-level GO.

## Negative controls — the part that makes step 9 evidence rather than assertion

A governance control that has never been observed _refusing_ something is not known to work. Each
of these must be demonstrated on a real PR, with the result recorded:

- A PR that edits `governance/gate-manifests/g1.yaml` without the operator updating the repository
  variable **must fail** `policy-integrity`.
- A PR touching a path outside the manifest's `allowed_paths` **must fail** `gate-scope`.
- A PR that deletes or `.skip`s a test **must fail** the test-deletion guard.
- Evidence that branch protection and CODEOWNERS review are actually enabled — `gh api` output or
  equivalent, not a screenshot of the settings page and not this document's word for it.

## Explicit non-scope

No G2 work. GPT-PM's ruling is explicit: G2 does not begin until G1 closes, and G2 additionally
carries `G2-PREFLIGHT-01/02/03` from `../G0_CLOSURE_REPORT.md`.

## What is NOT being reverted, and why

`b784265` stays. GPT-PM declined to require a revert-and-reapply purely to reconstruct a clean
process history, and reverting working, mutation-tested contract code to re-land it identically
would destroy real evidence (the mutation results, the CI history) to buy a tidier log. The
deviation is recorded in `../G0_CLOSURE_REPORT.md` and in `../../core/DECISION_LOG.md` instead —
an admitted bootstrap deviation is more honest than a rewritten history that implies the process
was followed.
