# G1 Remediation Plan

**Plan ID:** `pdos-g1-remediation-2026-09-10`
**Gate:** G1 — Repository + governance enforcement + CI + contracts
**Status:** OPEN. Steps 1-8 done (2026-09-11); R13 closed as an accepted risk (operator decision,
2026-09-11) and the scope-step negative control run (run `34640409639`). Remaining: the
`forbidden_paths` refusal, the hash-mismatch control (operator-only), the test-deletion control's
deletion half, the fresh-context review, and the closure report. See "Blocked on the operator".
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

## Blocked on the operator

**Updated 2026-09-11: two of these three are settled.** The section heading used to read "nothing
else can be verified until these are settled", which is no longer true and is left here only so the
change is visible rather than silent. **R11 and R12: RESOLVED** — the operator took the
make-it-public option, which closes both at zero cost. **R13: CLOSED as an accepted risk**
(operator decision, 2026-09-11) — no second GitHub identity will be created, so separation stays
procedural and no document in this repository may claim otherwise.

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
2. Operator settles R11/R12/R13                                 R11 DONE, R12 DONE,
                                                                R13 ACCEPTED (not fixed)
3. G1 plan reviewed and GO given                                DONE
4. Operator authors/adopts governance/gate-manifests/g1.yaml    DONE (operator-only, INV-28)
5. Operator sets GATE_MANIFEST_APPROVED_HASH_G1 repo variable   DONE (operator-only, out of tree)
6. Create branch gate/g1-remediation                            AUTHORIZED by GPT-PM APPROVE
7. Fix G1-M2: one governance workflow, hash-check -> scope-check DONE (see below)
8. Confirm CI actually runs and is green on that branch          DONE (run 34544309071, steps 4-6 green)
9. Negative-control PR tests (see below)                         2 of 4 done; the other two
                                                                are operator-owned
10. Fresh-context G1 review                                      pending
11. G1 closure report                                            pending
```

**Status of step 2, measured on 2026-09-11 rather than assumed.** The operator took the second R12
option: the repository is public (`gh repo view --json isPrivate` → `false`), which makes Actions
free and unmetered and closes **R11** with it, and ruleset `PDCC` (id `22899342`) is
`"enforcement": "active"` on `main`. **R13 is CLOSED as an accepted risk**, not fixed — it is the
one item here no amount of implementation can settle: one GitHub identity behind both roles means the audit trail cannot
distinguish implementer from operator, so any separation described in these documents is procedural,
not mechanical. The operator declined the second-identity branch of the mitigation on 2026-09-11,
which makes the other branch binding: no document here may assert mechanical separation.

**Status of step 9 — stated narrowly, because the obvious wider claim is not supported.** Two of the
four bullets are done: branch protection is now evidenced by `gh api` output rather than by this
document's word for it, and the scope-step refusal has now actually been run.

The **scope-step control has now been observed in BOTH directions.** It passed on run
`34544309071` (step 6, 28 paths, all in scope) and **refused** on run `34640409639`, job
`103398420489`, head `98716b3` — a PR carrying four changed paths of which exactly one,
`.gitignore`, is outside `allowed_paths`. The other three were not reported, so the check
discriminates within a single diff rather than failing wholesale. The hash step **succeeded** on
that run, which is what makes it evidence about scope at all: step 6 genuinely executed instead of
being skipped behind an earlier failure. The refusal also names the path as structured data in the
check-run annotation (`path: ".gitignore"`), not only in prose. Full record, including what it does
and does not establish: `G1_PREADOPTION_EVIDENCE.md` §11.

The instrument was a real change, not a synthetic one — `.dev.vars` is genuinely missing from
`.gitignore` and genuinely out of G1's scope, and the follow-up commit reverts it, leaving the gap
open for the gate that may legitimately close it.

The **hash-mismatch control** has not been run either; it requires a branch that deliberately edits
`g1.yaml`, which is operator-only territory.

The **test-deletion control has partial evidence and stays open.** On PR #5 the guard refused a real
PR in real CI (run `34632358953`), reaching `.mjs` files for the first time — but what it caught was
a **false positive** (string fixtures describing skip syntax), not a genuinely skipped test, and the
deletion half has still never fired on a real PR. Partial evidence is not the control.

The **test-deletion control was not demonstrable
as written until 2026-09-11**: the guard was blind to `.test.mjs`, so a PR deleting a `.mjs` test
would have passed it silently. Fixed and regression-tested — see `../../core/DECISION_LOG.md`,
entry "G1's own test-deletion guard was blind to `.test.mjs`".

### Step 7, as built

`policy-integrity.yml` and `gate-scope.yml` are replaced by a single `.github/workflows/
governance.yml` whose steps run in one job, in order: resolve gate -> verify manifest sha256
against the operator-held repository variable -> check changed paths. The scope step is
unreachable unless the hash step exited 0, which is the guarantee `GATE_MANIFEST_INTEGRITY.md`
had been claiming while the code did not provide it.

Two things were done beyond the literal finding, both because the finding exposed them:

- **The scope check moved from shell+`yq` into `scripts/verify/check-gate-scope.mjs`.** The shell
  version's behaviour depended on `yq` flag and expression semantics that differ between that
  command's Go and Python implementations, and with CI executing nothing (R11) there was no way
  to find out which one the runner has before merging. The Node version can be run and
  mutation-tested here and now: 20 unit tests, and 11 mutations — each one making the guard
  refuse _less_ — all killed by `npm run verify:mutation`.
- **Two real defects in the old matcher were found while porting it** and are recorded in
  `../GATE_MANIFEST_INTEGRITY.md`: bash `[[ path == pattern ]]` lets `*` cross `/`, so
  `packages/*` authorized the entire subtree; and an unparseable manifest produced an empty
  pattern list rather than an error. Neither was in GPT-PM's findings.

Also fixed, both of them side effects of the above rather than separate scope: `scripts/verify/`
added to CODEOWNERS (it now holds a governance check, so leaving it unprotected while protecting
`.github/` protects nothing), and `@eslint/js` declared explicitly — `eslint.config.js` imports it
directly while it was only present transitively.

### What the internal reviewers found before this was committed

Three read-only specialists (security, functional-test, code) reviewed the change before any
GPT-PM round, per the global contract's sequencing rule. They found four things worth the pass,
all remediated in one batch:

- **A silent-truncation defect in the manifest reader (MAJOR, security).** Any non-indented line
  ended a block, so a list item that lost its indent produced an empty list with no error. For
  `forbidden_paths` that is zero enforcement, invisible, in a file that still reads correctly to
  the operator giving it a hash approval. Fixed and recorded in `../GATE_MANIFEST_INTEGRITY.md`.
- **`run()` — the only function CI executes — had no test of any kind (MAJOR, tests).** Its exit
  code IS the control. A regression dropping the violation branch would have left every unit test
  green while the check exited 0 on a real violation. `main()` is now an exported `run()` with
  injected dependencies, and every exit path is asserted.
- **`changedPathsFrom()` had no test (MAJOR, tests)** — including the `-z` handling it exists for.
  Now tested against a real temporary git repository with filenames containing a space and
  non-ASCII characters.
- **A mutation whose label overstated what it proved (MAJOR, tests).** "Run past the end of the
  block" was killed by an "Unsupported line" error, not by the silent list-widening its name
  implied. Relabelled, and replaced by two mutations that do demonstrate the real hazard.

Two smaller ones: the `&` half of the alias/anchor rejection and the block-scalar rejection had no
assertions at all, so either could have been deleted with the suite staying green. Both are now
covered, each by its own mutation.

The claim in the design document was corrected too. It had said the matcher and reader were
mutation-tested — true of those two functions, and an overstatement of the file, since the part
CI runs was untested. `GATE_MANIFEST_INTEGRITY.md` now lists what is covered rather than
summarising it.

### The GPT-PM round found one more, in the fix itself

Round 1 (uncommitted diff) returned `VERDICT: APPROVE`, 0 findings. Round 2, against the actual
commit, returned **MAJOR** — and it was right:

> TDD_ERRATA.md is a new normative authority surface but is not CODEOWNERS-protected.

Creating a document that outranks the frozen TDD, and leaving it editable without operator review,
put a new authority surface **outside** the very trust boundary this change was tightening. An
implementer branch could have declared an architectural restriction superseded, or quoted an
authority that was never given, without touching a single protected path.

Fixed by protecting `/docs/architecture/` as a directory. That also closes a gap GPT-PM did not
raise, because it predates the errata file: **`TDD.md` itself was never CODEOWNERS-protected
either** — the frozen architecture baseline was editable without operator review the entire time.
Reported rather than folded in silently, since bundling an unrequested fix into a remediation is
how scope quietly grows.

`tests/policy/codeowners.test.mjs` now asserts the list of operator-owned paths, with three
mutations that delete or de-owner an entry, so a protection cannot be dropped silently. The
mutations act on `.github/CODEOWNERS` itself rather than on code, which is correct here: the data
is the control.

Final local state: `npm run verify` green with **88 tests** (39 for the scope guard, 12 for
CODEOWNERS), and `npm run verify:mutation` reports **all 30 mutations killed**.

**Deviation from the adopted TDD, flagged not hidden:** `docs/architecture/TDD.md`'s repository
tree names the two separate workflow files. GPT-PM's ruling ("один workflow / один dependency
chain") is followed instead; the frozen TDD is left untouched and the divergence is recorded in
`../GATE_MANIFEST_INTEGRITY.md` and `../../core/DECISION_LOG.md`. This needs GPT-PM's
acknowledgement at the step-10 review, since it is the product owner's document to reconcile.

Step 6's branch is authorized: GPT-PM returned an explicit APPROVE for "option (a)", naming
`gate/g1-remediation`, which under the global operating contract §20 is sufficient authorization
for branch creation. Subsequent `gate/gN-*` branches each still need their own gate-level GO.

## Negative controls — the part that makes step 9 evidence rather than assertion

A governance control that has never been observed _refusing_ something is not known to work. Each
of these must be demonstrated on a real PR, with the result recorded:

- A PR that edits `governance/gate-manifests/g1.yaml` without the operator updating the repository
  variable **must fail** the `Governance` check, at the hash step.
- A PR touching a path outside the manifest's `allowed_paths` **must fail** the `Governance`
  check, at the scope step — having reached that step only because the hash step passed. Both
  halves matter: reaching the scope step is what G1-M2 was about.
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
