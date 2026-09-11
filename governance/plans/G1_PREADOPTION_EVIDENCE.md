# G1 Pre-Adoption Evidence

**Status:** NON-BINDING PLANNING ARTIFACT. Records measurements and open questions; changes no
policy, corrects no document, authorizes nothing.
**Rosetta plan:** `personal-decision-os-2026-09-10T20-41-20-095Z-cd44c5`, hash
`0305b9818d8042e26fbf6e567edff7494af889a037d1331bb4a12832aa3a32f9`, GPT-PM `VERDICT: APPROVE`
(0 BLOCKER / 0 MAJOR).
**Measured:** 2026-09-10, at branch `gate/g1-remediation` = `60c2aeb`, `main` = `5574681`. Sections
9 and 10 were added later, on 2026-09-11, at `gate/g1-remediation` = `091718b`, `main` = `34b9d2d`;
each states its own measurements and run ids rather than inheriting this line's.

**The title is now half historical.** Pre-adoption is over: §10 records the operator adopting the
manifest and the scope check passing. Sections 1-9 are kept as the record of what was known before
that, including the inferences that later measurement overturned. The file is renamed by nothing —
renaming it would break every reference to it in the decision log and the manifest for no gain.

## Why this file exists rather than a set of document corrections

GPT-PM's review of the previous plan returned a BLOCKER: correcting `GATE_MANIFEST_INTEGRITY.md`,
`RISK_REGISTER.md`, `CODEOWNERS` and the operating contracts is **real G1 remediation work**, and
G1 remediation may not proceed before a binding, operator-adopted `g1.yaml` manifest exists. The
findings below are therefore **recorded, not fixed**. Each one names the file and line so the
correction, when it is authorized, is a mechanical edit rather than a rediscovery.

Every claim here is traceable to a primary source quoted in place. Nothing is restated on the
authority of an earlier session's summary — one such restatement is itself corrected in §5.

---

## 1. R11 — GitHub Actions execution

**Method.** Unauthenticated `GET https://api.github.com/repos/xLZDx/Personal_Decision_Command_Center/actions/runs`
and `.../actions/runs/<id>/jobs`.

| Run           | Head sha  | Event | Branch | Created (UTC)    | Duration | Jobs | **Steps** | Conclusion |
| ------------- | --------- | ----- | ------ | ---------------- | -------- | ---- | --------- | ---------- |
| `34513131209` | `b784265` | push  | main   | 2026-09-10 18:14 | 4 s      | 1    | **0**     | failure    |
| `34515018325` | `5574681` | push  | main   | 2026-09-10 18:32 | 3 s      | 1    | **0**     | failure    |

**FACT.** Two runs exist in this repository's entire history. Both report `steps: 0`. Neither
executed a single step. The `verify` job (`102991918020`, `102998154518`) started and completed
within the same 3-4 seconds.

**FACT.** Both runs predate publication: the repository's `pushed_at` is 2026-09-10 19:46 UTC and
the operator made it public after that. So neither run is evidence about the _current_ billing
state — they are evidence about the state that produced R11.

**FACT.** No run exists for `gate/g1-remediation`. This is expected, not a symptom:
`.github/workflows/ci.yml` triggers on `push: branches: [main]` and `pull_request`, and
`.github/workflows/governance.yml` on `pull_request` only. A branch push matches neither.

**SUPERSEDED BY MEASUREMENT — see §8.** This section previously ended with an INFERENCE, labelled
as such: publication _should_ have removed the block, but no run had executed a step since, so R11
stayed open, and one pull request was named as the whole test. That test has now been run.

**FACT.** PR #1 produced runs `34533959619` (`CI`, **15 steps**, success) and `34533959777`
(`Governance`, **9 steps**, failure). Non-zero step counts. Actions execute on this repository.
R11 is factually resolved; the register update is deferred behind the binding manifest per §8.4.

The inference above is kept rather than deleted, so the record shows what was believed before it
was known.

## 2. R12 — branch protection

**FACT.** `GET /repos/.../branches` (unauthenticated) reports `protected: false` for **both**
`main` and `gate/g1-remediation`. No protection of any kind is configured today.

**FACT.** The repository is public: `private: false`, `visibility: "public"`. The success of an
_unauthenticated_ API read is itself the proof, independent of any field value.

**Consequence.** Branch protection is available on the Free plan for a public repository, so R12's
original premise — that protection required a paid plan — no longer holds. The control is now
available and simply not switched on.

**FACT.** `GET /repos/.../branches/main/protection` returns **HTTP 401** unauthenticated and
**HTTP 404 `{"message":"Branch not protected"}`** authenticated. Both readings agree: nothing is
protected. See §5 for a correction this measurement forced on an earlier paragraph of this same
document.

## 3. R13 — implementer identity, stated narrowly

GPT-PM's MAJOR on the previous plan was that R13 was being over-read. The narrow, defensible
statement follows; the broad one that was rejected is stated too, so nobody re-derives it.

**FACT, and this is the decisive measurement.** Every commit in this repository — all five on
`main` and all three on `gate/g1-remediation` — is authored by the single identity
`xLZDx <25364989+xLZDx@users.noreply.github.com>`:

```
5574681 xLZDx <25364989+xLZDx@users.noreply.github.com>  G0 CLOSED (GPT-PM APPROVE); G1 held...
b784265 xLZDx <25364989+xLZDx@users.noreply.github.com>  G1: toolchain, CI, governance...
71ab1cf xLZDx <25364989+xLZDx@users.noreply.github.com>  G0 evidence: live-verify...
9e67d6e xLZDx <25364989+xLZDx@users.noreply.github.com>  Add tool-agnostic AGENTS.md...
fb45aab xLZDx <25364989+xLZDx@users.noreply.github.com>  Scaffold repository structure...
```

**THE NARROW CLAIM (supported):** CODEOWNERS cannot mechanically prove operator-vs-implementer
identity separation when both act as `xLZDx`. GitHub forbids a pull request's author from
approving their own pull request, so "required review from Code Owners" plus a single account is a
deadlock, not a control.

**THE BROAD CLAIM (rejected, do not adopt):** that GitHub therefore cannot enforce anything and
the whole layer is procedural. False. GitHub can still mechanically require a pull request, require
status checks to pass, forbid force-push and deletion, and apply all of it to administrators —
none of which depends on distinguishing two humans. See §6.

**Measured implementer capability, which is the thing GPT-PM asked be checked rather than assumed
from the account name.** As of the AS-OF cutoff, this session's actual GitHub capability was:

| Capability                  | State                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `gh` CLI                    | not installed anywhere searched (Program Files, LocalAppData, WinGet Links, scoop, chocolatey) |
| `GH_TOKEN` / `GITHUB_TOKEN` | not set — no environment variable matching `GH_\|GITHUB` exists                                |
| `%APPDATA%\GitHub CLI`      | absent                                                                                         |
| Authenticated REST access   | none — `/branches/main/protection` returns HTTP 401                                            |
| `git push`                  | works, via `credential.helper=manager` over HTTPS                                              |
| Direct push to `main`       | **exercised five times**, commits `fb45aab` … `5574681`                                        |

So the implementer's capability was: push to any branch including `main`, and nothing through the
API. Opening a pull request was not possible.

**Changed twice during this plan, both times by direct operator action.** First, GitHub CLI 2.100.0
was installed at `C:\Program Files\GitHub CLI\gh.exe` ("установи gh"). Then the operator
authenticated it with a token ("логин есть", "логин через токен"). The credential was never
requested, seen, echoed or extracted by the implementer — the operator supplied it directly to
`gh`, which stores it in the Windows keyring.

### 3.1 The capability finding this created, and it is the most serious in this document

**FACT.** `gh auth status` now reports `Logged in to github.com account xLZDx (keyring)` with a
classic PAT whose scopes are:

```
admin:enterprise, admin:gpg_key, admin:org, admin:public_key, admin:repo_hook,
admin:ssh_signing_key, audit_log, codespace, project, repo, user, workflow,
write:network_configurations, write:packages
```

**FACT.** `gh api repos/xLZDx/Personal_Decision_Command_Center --jq '.permissions'` returns
`{"admin":true,"maintain":true,"pull":true,"push":true,"triage":true}`.

**Consequence, stated plainly because the whole G1 design rests on the opposite assumption.** The
manifest-integrity mechanism is built on the premise that the approved hash lives _outside the
implementer's reach_ — `governance/GATE_MANIFEST_INTEGRITY.md` and the proposal's own HOW TO ADOPT
section both say so, in those words. With an `admin`-scoped classic PAT reachable from the
implementer's session, that premise is **false**. The same session that writes the manifest can:

- set or change `GATE_MANIFEST_APPROVED_HASH_G1` (`repo` scope covers repository variables);
- adopt `governance/gate-manifests/g1.yaml` and then set the hash to match it — the exact
  self-authorizing loop NM3 identified and this mechanism exists to prevent;
- create, weaken or delete branch protection (`admin: true`);
- edit workflows (`workflow` scope), including the Governance workflow that polices them;
- merge its own pull request.

This does not mean any of that will happen — it means **none of it is prevented mechanically**.
Every control in this repository that is described as operator-held is, as of now, procedural:
it rests on the implementer not doing something it is fully able to do.

The classic PAT also has no per-repository boundary, so the same is true of every other repository
this account can reach — beyond G1's scope, but it is the operator's to know.

**What would restore the mechanical property**, if the operator wants it back — none of it is the
implementer's to choose:

1. A fine-grained PAT scoped to this repository, without `administration` (branch protection) and
   without `variables`/`secrets` write. The implementer keeps `contents` and `pull_requests`; the
   approval hash returns to being unreachable.
2. Or: keep the broad token out of the agent's environment entirely and let the operator run the
   few admin operations by hand.
3. Or: accept the procedural model explicitly and stop describing these controls as mechanical —
   the option this document's §4 already shows the repository has been implicitly taking.

Option 3 is what the documents currently claim; options 1 and 2 are what they currently _describe_.

## 4. Stale claims found — recorded, deliberately NOT corrected

Each is false against the measurements above. None is edited under this plan.

| Location                                     | Claim                                                                                                       | Why it is false                                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `governance/GATE_MANIFEST_INTEGRITY.md:31`   | "`main` is a protected branch. The implementer has no direct-push and no merge permission."                 | `protected: false`; the implementer pushed directly to `main` five times.                                                                                  |
| `governance/GATE_MANIFEST_INTEGRITY.md:34`   | a PR touching authority paths "requires review from `CODEOWNERS` — i.e. the operator — before it can merge" | With no branch protection, nothing requires any review. With one account, it could not distinguish the reviewer anyway.                                    |
| `.github/CODEOWNERS:3-5`                     | "This file is the control that actually enforces the governance invariant"                                  | CODEOWNERS enforces nothing until branch protection requires code-owner review — which the file's own lines 7-9 correctly say, contradicting lines 3-5.    |
| `governance/plans/G1_REMEDIATION_PLAN.md:19` | "`/branches/main/protection` returns 404, repo is `private: true`"                                          | Both halves are now stale: the repository is public, and that endpoint returns 401 unauthenticated. Accurate when written; kept as the historical finding. |

`AGENTS.md:28` ("must never … merge/push to a protected branch") is **not** in this table. It is a
prohibition on the agent, conditional on protection existing — not a false assertion that it does.

## 5. A withdrawal, then the withdrawal itself withdrawn — both kept visible

This section changed twice in one sitting. Both versions are recorded, because how the conclusion
moved is more instructive than where it landed.

**First version (written before `gh` was authenticated).** An earlier session had recorded that
`/branches/main/protection` "now answers `Branch not protected` rather than refusing on plan
grounds". Probing it unauthenticated returned **HTTP 401**, and no authenticated path existed at
the time, so the claim was written up here as unreproducible and withdrawn.

**Correction, after the operator authenticated `gh`.** Authenticated, that endpoint returns
**HTTP 404 with `{"message":"Branch not protected"}`** — verbatim what the earlier session
reported. **The earlier claim was right and the withdrawal was wrong.** The 401 was not evidence
against it; it was evidence that the probe had no credential, which is a fact about the probe and
not about the branch.

**The actual error, which is worth more than the fact.** "I could not reproduce it" was allowed to
stand in for "it is not true", when the two differ by exactly the capability the probe lacked. A
failed measurement is evidence about the measurement first. The conclusion drawn from it — that
`main` is unprotected — was correct throughout, which is what made the mistake comfortable enough
to write down: the bottom line never moved, only the reason under it, and a reason nobody checks is
how a document ends up right by accident.

Kept rather than deleted: a governance repository that quietly tidies away its own bad evidence is
worse than one that leaves it legible.

## 6. Branch-protection configuration for the operator's decision (NOT applied)

GPT-PM's recommendation for the single-account case. Reproduced for the operator to decide on; no
setting is touched by this plan.

| Setting                             | Target  | Why                                                      |
| ----------------------------------- | ------- | -------------------------------------------------------- |
| Require a pull request before merge | **ON**  | Closes the direct-to-`main` path — the gap §4 documents. |
| Require the `CI` status check       | **ON**  | No merge with a red build.                               |
| Require the `Governance` check      | **ON**  | Makes the manifest hash + scope checks binding on merge. |
| Required approving reviews          | **0**   | Avoids the self-approval deadlock of §3.                 |
| Require Code Owner review           | **OFF** | Same reason. With one account it can only deadlock.      |
| Apply to administrators/owner       | **ON**  | Otherwise the owner bypasses everything above.           |
| Allow force push                    | **OFF** |                                                          |
| Allow deletion                      | **OFF** |                                                          |

**What this configuration is honest about:** it gives GitHub no ability to tell Claude from Ivan.
Human operator review and the GPT-PM verdict are a **procedural** governance layer. What the
configuration does provide mechanically is the absence of direct-to-`main` writes and the absence
of merges over red checks — real controls that do not depend on identity separation.

## 7. The manifest proposal

`G1_MANIFEST_PROPOSAL.yaml` — non-binding, implementer-authored, no authority.

- **24** `allowed_paths`, **4** `forbidden_paths`, no bare `**`.
- Scoped to the **cumulative** PR merge range, because the guard evaluates
  `git diff BASE_SHA...HEAD_SHA` — a manifest listing only future work would fail on paths the
  branch already carries. Each entry is tagged `[CUMULATIVE]` / `[REMAINING]` / `[BOTH]`.
- Validated through the production reader and matcher themselves — `parsePathList`,
  `compilePattern`, `checkScope` imported from `../../scripts/verify/check-gate-scope.mjs`, never a
  second more forgiving parser: all 24 changed paths in scope, **17** negative controls refused,
  **11** positive controls accepted, every pattern compiles, `vacuous` empty.
- `proposal_sha256` = `26a5a9135c9e9bcfb2ea75ac825416b7a0a34ac5185f0d67aca52cc6d6a8c764`
  (18012 bytes) — **evidence of what was reviewed, and not the approval hash.** The approval hash
  must be computed from the file the operator actually adopts, which cannot be this one
  byte-for-byte; the proposal's own "HOW TO ADOPT" section explains why.
- **Digest history, because three documents quoting three digests is its own defect.** `3b0c9cc…`
  (16346 bytes) is the file as the approved plan text quotes it. `929849f…` (17461 bytes) added
  limitation 5, after §3.1's finding made a statement in the file false. `26a5a91…` (18012 bytes)
  is the current one: it narrowed the authority claim on the first screen, which said the approval
  hash lived behind "a repository variable only the operator can set" — an absolute that §3.1
  disproves. A plan's hash is fixed at approval and is never back-edited, so the older value stays
  in the plan and this line is the reconciliation. Recompute rather than trust any of them.
- **Two counts that both read 28, and are not the same 28.** The manifest declares **28 patterns**
  (24 `allowed_paths` + 4 `forbidden_paths`). The branch happens to touch **28 changed paths**
  since `a33140e` added four files. The coincidence is noted here so a later reader does not take
  one number as evidence for the other; an earlier version of this project's closure evidence
  reported "27 patterns (23 + 4)", which was simply wrong and was caught in review.

## 8. The prediction, and what actually happened

The prediction was written down **before** the pull request existed, so that a miss would have been
as visible as a hit: `CI` passes, `Governance` fails at the manifest step, and the scope step is
unreachable behind it. **It held in full.**

### 8.1 The run

PR **#1**, `gate/g1-remediation` → `main`, opened at head `3c43d06` with `Gate: G1` in the body.

| Run           | Workflow     | Event          | Conclusion  | Job            | **Steps** | Duration |
| ------------- | ------------ | -------------- | ----------- | -------------- | --------- | -------- |
| `34533959619` | `CI`         | `pull_request` | **success** | `103061087465` | **15**    | 33 s     |
| `34533959777` | `Governance` | `pull_request` | **failure** | `103061087929` | **9**     | 10 s     |

**The step counts are the headline, not a detail.** Every previous run in this repository's history
— `34513131209` and `34515018325` — reported `steps: 0` and finished in 3-4 seconds: the Actions
billing block, nothing executing. Fifteen executed steps is the first proof that CI on this
repository runs at all.

### 8.2 CI: 15 steps, every one green

`npm ci`, Format, Lint, Typecheck, Tests, "Assert the suite actually ran tests", the test-deletion
guard, the secret scan and the dependency audit all executed and all succeeded. The 88 tests that
were only ever local evidence are now evidence that ran on a clean machine from a clean checkout.

### 8.3 Governance: the guard observed refusing, and the ordering observed holding

```
4. Resolve the gate this PR belongs to                      success
5. Verify manifest hash against operator-controlled state   FAILURE
6. Check changed paths against the verified manifest        SKIPPED
```

Verbatim from the failed step's annotations:

> No manifest at governance/gate-manifests/g1.yaml and no approved hash for G1.
> The operator must author and adopt the manifest, and set the repository
> variable GATE_MANIFEST_APPROVED_HASH_G1, before this gate can merge.
> An implementer-authored manifest has no authority (INV-28).

Two separate claims are settled by those nine steps, and both had been assertions until now:

1. **The guard refuses.** This is the first time in this project's life that a control has been
   observed saying no to anything. Everything before it was a description of a control.
2. **The scope check is unreachable behind the hash check** — step 6 `SKIPPED`, not merely failed.
   That ordering is precisely what G1-M2 was about: validating a diff against a manifest whose
   integrity was never established is circular, because the diff could have rewritten the manifest
   that authorizes it (NM3). The one-workflow rewrite claimed to close that. It does.

Step 4 also succeeded, which is its own small fact: the workflow found `Gate: G1` in the PR body
and resolved the manifest path from it. The gate label remains implementer-written — limitation 6
of `../GATE_MANIFEST_INTEGRITY.md` — and that is unchanged by this run.

### 8.4 R11: factually resolved, register update deliberately deferred

**Measured R11 closure evidence: non-zero Actions steps observed (15 and 9), so R11 is factually
resolvable.** The `core/RISK_REGISTER.md` update is **not** made here. Changing a risk's status is
G1 document remediation, and that waits for a binding manifest exactly like the corrections in §4.
The standing MVP1 GO replaced the operator-GO requirement, not the manifest requirement. Recorded
rather than acted on, deliberately.

### 8.5 One incidental finding, not blocking

Both jobs carried a warning: `actions/checkout@v4` and `actions/setup-node@v4` target Node.js 20,
which is deprecated on GitHub runners and is being forced onto Node.js 24. Nothing failed because
of it. It belongs in the backlog as a pin-refresh, not in this gate.

A control never observed refusing anything is not known to work. This one has now been observed
refusing.

## 9. The candidate manifest exists, and the guard's refusal changed

**2026-09-11.** The operator delegated authoring — _"го создай манифест за меня и всё что ты
можешь сделать сам. логины в конце"_ — and did not delegate approving. GPT-PM was asked to rule on
whether the delegation reached the approval hash, and ruled that it does not. So
`governance/gate-manifests/g1.yaml` now exists on `main`, written by the implementer, as an
**operator-review candidate** that says in its own header that it carries no authority yet.

**FACT.** Committed to `main` as `34b9d2d`, its own commit, outside PR #1. That placement is not
stylistic: `governance/gate-manifests/**/*.yaml` is in the manifest's own `forbidden_paths`, so a
gate PR carrying its own authorizing manifest would fail the very check it was trying to satisfy —
which is NM3 stated as a diff.

**FACT, asserted rather than reasoned.** `git diff --name-only main...gate/g1-remediation` does not
list `governance/gate-manifests/g1.yaml`. Zero occurrences. The three-dot range starts after the
manifest's introduction once `main` is merged into the gate branch, so the PR never carries it.

### 9.1 The transition that proves the manifest was read

Runs A and B failed with _"No manifest at governance/gate-manifests/g1.yaml and no approved hash"_.
**Generation C fails with a different sentence**, and the difference is the evidence:

| Generation | Head      | CI                | Governance       | Step 5 message          | Step 6      |
| ---------- | --------- | ----------------- | ---------------- | ----------------------- | ----------- |
| A          | `3c43d06` | success, 15 steps | failure, 9 steps | no manifest, no hash    | **SKIPPED** |
| B          | `5bbf783` | success, 15 steps | failure, 9 steps | no manifest, no hash    | **SKIPPED** |
| C          | `7ad63fa` | success, 15 steps | failure, 9 steps | **variable is not set** | **SKIPPED** |

Verbatim from run `34543242198`, job `103090262040`:

```
manifest: governance/gate-manifests/g1.yaml
actual:   e95bfcf5e97580d1e9f076de47f6da4e4b7e31bd5e57b162c5c4cdfdf43ed162
##[error]Repository variable GATE_MANIFEST_APPROVED_HASH_G1 is not set.
```

The runner found the file, read it, and hashed it. What is missing is now the operator's approval
and nothing else. Step 6 is still `SKIPPED`, so the ordering still holds with a manifest present —
which runs A and B could not demonstrate, because there was no manifest to get past.

### 9.2 The hash, cross-checked two ways before being handed over

| Source                                      | Value                                                              |
| ------------------------------------------- | ------------------------------------------------------------------ |
| Local: `git cat-file -p` on blob `ad19d7df` | `e95bfcf5e97580d1e9f076de47f6da4e4b7e31bd5e57b162c5c4cdfdf43ed162` |
| CI: the `actual:` line of run `34543242198` | `e95bfcf5e97580d1e9f076de47f6da4e4b7e31bd5e57b162c5c4cdfdf43ed162` |

Identical. 21257 bytes. Both are computed from the **LF** bytes git stores and the runner checks
out — a hash taken from a Windows working copy with CRLF endings will not match, which is the
reason the value is supplied at all.

**It is supplied to remove a byte-encoding trap, not to remove the reading.** The workflow's own
error text says setting the printed value without reading the manifest reduces the control to a
rubber stamp, and the candidate repeats that warning in its header.

### 9.3 A local verification trap, and it is the same CRLF trap as the hash

Worth recording because it made local verification **lie in the failing direction**, and because it
is the identical byte-encoding problem that makes §9.2's hash worth cross-checking.

`core.autocrlf` is `true` on this machine. Switching branches to place the manifest on `main` and
back re-materialised every file that differs between the two commits — converting them to CRLF,
where the same checkout had been LF before. Two things then broke locally while CI stayed green:

- `prettier --check .` reported **18 files** with style issues. `--end-of-line auto` reported all
  of them clean. The difference was line endings and nothing else.
- `vitest` reported `SyntaxError: Invalid or unexpected token` in `tests/policy/gate-scope.test.mjs`,
  with the caret pointing at a line the reported position did not match — the signature of offset
  drift in Vite's SSR transform on CRLF input. `node --check` parsed both the test and the module
  it imports without complaint, and a direct `import()` returned all six exports.

**The measurement that settled it, after two wrong guesses.** `git cat-file -s` is authoritative
where a piped `grep` is not: `AGENTS.md` is **4129** bytes in git and was **4201** in the working
tree — exactly +72, the file's line count. An earlier probe using `grep -c $'\r'` reported 72 CRs in
the blob too; that probe was counting lines containing the letter `r`, not carriage returns, and it
sent the diagnosis down a false path for two steps. Byte counts do not have that failure mode.

Normalising the working tree with the project's own `prettier --write .` restored 88/88 tests and
30/30 mutations killed. `git diff --numstat` then showed real content changes in **three** files
only; the other 18 were line-ending noise in `git status`'s stat cache, with zero diff.

**Nothing in the repository was ever wrong** — CI proved it independently at every step, since the
runner checks out the LF bytes git actually stores. The lesson is narrower and worth keeping: on
this machine a branch switch can make the local suite fail on content that is correct, and the
first instinct — that the code broke — is the wrong one.

### 9.4 An incidental measurement

The same push made `main`'s own CI execute for the first time: run `34543145719`, **15 steps,
success**. Worth recording because it was an open question — the toolchain fixes are on the gate
branch, so `main` passing on its own was not certain.

## 10. Adoption, and the first time the scope check ever ran

**2026-09-11.** The operator read the candidate, agreed with it, and adopted it:

> "Прочитал g1.yaml, и согласен с документом, ГО поставь Переменную GATE_MANIFEST_APPROVED_HASH_G1"

**FACT.** `gh variable list` now reports `GATE_MANIFEST_APPROVED_HASH_G1` =
`e95bfcf5e97580d1e9f076de47f6da4e4b7e31bd5e57b162c5c4cdfdf43ed162`, set 2026-09-11T08:55:08Z, and
`git cat-file -p origin/main:governance/gate-manifests/g1.yaml | sha256sum` returns the identical
value. The variable and the file agree; re-checked immediately before this section was written.

**FACT.** Re-running the Governance workflow on PR #1's head `091718b` — run `34544309071`, job
`103206087659` — produced the first **successful** Governance job in this repository's history:

| Step                                                 | A       | B       | C       | D       | **E**       |
| ---------------------------------------------------- | ------- | ------- | ------- | ------- | ----------- |
| 4. Resolve the gate                                  | success | success | success | success | **success** |
| 5. Verify manifest hash against operator state       | failure | failure | failure | failure | **success** |
| 6. Check changed paths against the verified manifest | SKIPPED | SKIPPED | SKIPPED | SKIPPED | **success** |

Verbatim from the job log:

```
Manifest hash matches the operator-approved value.
Changed paths (28):
All 28 changed path(s) are within G1's approved scope.
```

**Why this is the section that matters.** Step 6 had never executed. Not once, in any run, under any
head. A and B could not reach it — no manifest. C and D could not reach it — no approved hash. The
ordering had therefore only ever been observed doing half its job: refusing. A control that has only
been seen saying no is exactly as unproven as one that has only been seen saying yes, because
"always refuses" and "works" look identical from outside. Both answers have now been observed, on
the same mechanism, with the only change between them being the operator's own act.

### 10.1 The authority caveat this adoption carries

The hash was written with the implementer's own credential, at the operator's explicit instruction,
after the operator read the bytes. GPT-PM's ruling required exactly that review — _"The operator
must review the exact committed bytes and set the verified hash only if adopting them"_ — and the
review happened. But **the GitHub audit trail cannot distinguish the operator's judgement from the
implementer's keystroke**, because of §3.1: one account, one admin-scoped token. The evidence of
whose decision this was lives in `core/DECISION_LOG.md` and the session transcript, not in a
separable actor. Recorded here so that a later auditor reading only GitHub does not mistake the
state for something stronger than it is, and as one more reason the §3.1 credential decision is
worth making.

### 10.2 The mechanism bit its author within the hour

`.gitignore` covers `.env` and `.env.*` but **not** `.dev.vars`, which is where `wrangler` keeps
local secrets — a real gap, found while writing the operator's credential instructions. It was not
fixed: `.gitignore` is not in the now-binding `allowed_paths`, so the change belongs to G2, where
secrets first appear. The workaround until then is `.env`, which is already ignored. A finding that
could have been quietly folded into an unrelated commit an hour ago now cannot be.

## 11. The scope step observed REFUSING — the other half of §10

§10 recorded the scope step passing for the first time. That closed one gap and opened its mirror
image: **the scope step had then been observed only in the direction that lets work through.** The
refusals already on record — sections 8.3 and 9.1, and the four failed runs in §10's table — all
happened at the **hash** step, which fails closed _before_ scope is ever evaluated. Those prove the
ordering, not the scope rule. Until this section, nothing in this repository demonstrated that the
scope check can say no.

**The instrument was chosen to be a real change, not a synthetic one.** §10.2 above recorded the
`.dev.vars` gap and the fact that the now-binding manifest refuses to let G1 close it. PR #7 made
that change anyway, on purpose: `.gitignore` gained `.dev.vars`, `.dev.vars.*` and
`!.dev.vars.example` (commit `98716b3`), alongside the report pair and decision-log wording fix that
are legitimately in scope.

**Why `.gitignore` specifically.** `governance/gate-manifests/g1.yaml` names it in its own
"DELIBERATELY EXCLUDED" block — _"Present in the repository, untouched by G1"_ — so the path is out
of scope by the manifest's explicit reasoning, not by an omission that could be argued as accidental.
It is also deliberately **not** one of the four `forbidden_paths`: those carry their own refusal
message, and the control being exercised here is the ordinary out-of-scope one.

**FACT.** Run `34640409639`, job `103398420489`, head `98716b3`, base `c0e4a08`. Step 5 (hash)
**succeeded**, so step 6 genuinely ran rather than being skipped; step 6 then **failed**. Verbatim
from the job log:

```
Manifest hash matches the operator-approved value.
...
Changed paths (4):
  .gitignore
  core/DECISION_LOG.md
  reports/G1_governance_document_corrections.html
  reports/G1_governance_document_corrections.ru.html
::error file=.gitignore::outside G1's approved scope
::error::1 path(s) outside the approved scope for G1. Widening the manifest to fit the diff is not
the fix -- a scope change needs a new plan and a new GO.
```

**The path is machine-attributable, not only prose.** The check-run annotation carries it as
structured data — `GET /repos/xLZDx/Personal_Decision_Command_Center/check-runs/103398420489/annotations`
returns `{"annotation_level":"failure","path":".gitignore","message":"outside G1's approved scope"}`.
So the refusal names the offending path in a form a reviewer can verify without reading a log.

**What this establishes, stated at its real width.** Three of the four changed paths matched
`allowed_paths` and were not reported; exactly one did not and was. The check therefore discriminates
between in-scope and out-of-scope paths within a single diff — it is not failing the whole run on any
change, and it is not passing everything. Together with §10 the same mechanism has now been observed
answering both ways, with nothing changing between the two observations except the content of the
diff.

**What it does NOT establish.** The `forbidden_paths` branch is still unexercised — no run has ever
touched one of the four authority paths, so its distinct refusal message has never been produced by
CI. Nor is the hash-mismatch control exercised here: that needs a branch that deliberately edits
`g1.yaml`'s approved hash. Both were closed the same day — see §12.

**The revert is part of the control, not a retraction of it.** The commit immediately following
`98716b3` on `gate/g1-remediation` — the one carrying this section — removes the three
`.gitignore` lines again, restoring the PR to green so it can be reviewed and merged on its
legitimate content. The refusal is the deliverable; the file change was the instrument. `.dev.vars`
stays uncovered until a gate whose manifest allows that path lands the same three lines — which is
exactly the outcome §10.2 predicted, now demonstrated rather than asserted.

## 12. The last three negative controls, executed the same day

§11 left three controls open, each for a stated authority reason: exercising `forbidden_paths`
means touching a protected governance path; exercising the hash-mismatch control means setting the
CI approval variable to a value that would make it wrong; exercising the deletion half of the
test-deletion guard means deleting a tracked test file. All three were narrowed to what they
actually require by `~/.claude/CLAUDE.md` §25, added 2026-09-12 on operator instruction ("надо
обновить правило и не блокировать эти действия в будуещем, мы всегда сможем востоновить из гита"):
the operative property is recoverability, not the word "delete" or "forbidden" — a git-tracked file
comes back byte-for-byte, a reverted branch commit never reaches `main`, and a variable set to a
deliberately WRONG value only ever makes a gate stricter. Branch creation itself was authorized by
the operator directly, then confirmed by a GPT-PM `VERDICT: APPROVE` naming all three branches by
name, base and purpose (satisfying §14 via §20 — branch creation is reversible); the exchange is in
`core/DECISION_LOG.md`, "Branch creation for the three negative controls".

### 12.1 Hash mismatch

**FACT.** Branch `gate/g1-hash-control`, base `origin/main` @ `005b8e6`, PR #10. Run `34654217044`
(rerun after each variable change, since GitHub Actions reads repository variables live at
execution time — the run that fired automatically on PR creation, before the variable was flipped,
read the correct value and is not evidence of anything).

With `GATE_MANIFEST_APPROVED_HASH_G1` set to `0000...0000`:

```
manifest: governance/gate-manifests/g1.yaml
actual:   e95bfcf5e97580d1e9f076de47f6da4e4b7e31bd5e57b162c5c4cdfdf43ed162
::error::Manifest hash mismatch for G1.
::error::actual:   e95bfcf5e97580d1e9f076de47f6da4e4b7e31bd5e57b162c5c4cdfdf43ed162
```

Step 6 (scope) did not run — the job stopped at step 5, exactly as designed. With the correct value
`e95bfcf5e97580d1e9f076de47f6da4e4b7e31bd5e57b162c5c4cdfdf43ed162` restored and the **same run
rerun again**, both steps report `success`. PR #10 was merged for its durable
`core/DECISION_LOG.md` entry — the only content it carried.

### 12.2 forbidden_paths

**FACT.** Branch `gate/g1-forbidden-control`, base `origin/main` @ `005b8e6`, PR #11 (closed
unmerged). Commit `998831d` appended one line to `governance/operator-approvals/README.md`, which
`g1.yaml` lists under `forbidden_paths`. Run `34654474743`:

```
Manifest hash matches the operator-approved value.
Changed paths (1):
::error::forbidden by the G1 manifest (pattern: governance/operator-approvals/**)
```

The hash step passed first, so the scope step genuinely evaluated the path rather than being
skipped — and the message is textually distinct from §11's `outside G1's approved scope`, exactly
as the manifest's own comments describe: forbidden paths get their own refusal, not the generic
out-of-scope one. Commit `ad2a407` reverted the edit in the same PR; `git diff origin/main HEAD --
governance/operator-approvals/README.md` reports zero lines, confirming byte-identity with `main`.
The restored-green run then passed both steps. PR #11 was closed **unmerged** — `main` was never
touched by this branch.

### 12.3 Test-deletion guard, deletion half

**FACT.** Branch `gate/g1-deletion-control`, base `origin/main` @ `005b8e6`, PR #12 (closed
unmerged). Commit `a3e6cf3` deleted `tests/policy/codeowners.test.mjs`. Run `34654709448`, step
"Test-deletion guard" (in the `verify` job, not `governance` — `governance` passed, correctly,
since no path in this diff falls outside `allowed_paths`):

```
BASE_SHA: 005b8e6882cea23d87efac030e620704a9546e1a
HEAD_SHA: a3e6cf34d928948691a92043ba5d4c5118715788
Test-deletion guard tripped:
  - deleted test file: tests/policy/codeowners.test.mjs
```

This is the **first time** the deletion half of this guard has fired on a real PR. The only earlier
evidence (PR #5, `core/DECISION_LOG.md` "G1's own test-deletion guard was blind to `.test.mjs`") was
the newly-skipped-test half, and that run was a false positive on string fixtures — the deletion
half had never been exercised before this run. PR #12 was closed **unmerged**; `main`'s copy of the
file was never touched.

### 12.4 What all four negative controls now establish together

| Control                     | Direction observed       | Evidence                                                                                      |
| --------------------------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| Scope (`allowed_paths`)     | PASS and REFUSE          | §10 (pass), §11 (refuse, run `34640409639`)                                                   |
| Hash mismatch               | REFUSE and restored PASS | §12.1, run `34654217044` (both directions, same run id)                                       |
| `forbidden_paths`           | REFUSE and restored PASS | §12.2, run `34654474743`                                                                      |
| Test-deletion (delete half) | REFUSE                   | §12.3, run `34654709448` — restoration not applicable, the file was never deleted from `main` |

Every mechanical control this repository's governance workflow can produce has now been observed
refusing at least once, on a real CI run, with the exact log line quoted above it rather than
paraphrased. None of the four PRs that produced this evidence altered `main` beyond what it already
was, except PR #10's single decision-log line.

## 13. Operator boundary — nothing below is the implementer's

Note the change §3.1 makes to this list. These are not operator-only because the implementer
_cannot_ do them; the credential now can. They are operator-only because they are the authority the
whole mechanism is built on, and an implementer that adopts its own manifest and sets its own
approval hash has authorized itself. The boundary is held by choice, and saying so is the point.

1. ~~Adopt an authoritative `governance/gate-manifests/g1.yaml`~~ — **authoring delegated and
   done** (§9). What exists is a candidate; adopting it is step 2, not step 1.
2. ~~Read the candidate, then set `GATE_MANIFEST_APPROVED_HASH_G1`~~ — **done 2026-09-11** (§10).
   The operator read the bytes, agreed, and adopted them; the variable is set and the scope check
   passes. Read §10.1 before treating this as a fully mechanical separation: it is not one yet.
3. Merge PR #1. **INV-20, and it is now the only thing left blocking the gate** — the checks are
   green, so what remains is authority, not evidence.
4. ~~`gh auth login`~~ — **done**, by the operator, during an earlier plan.
5. Decide and apply branch protection (§6).
6. **The one this document most wants an answer to:** decide the credential model of §3.1. A
   fine-grained token, a hand-operated admin path, or an explicit acceptance that these controls
   are procedural. Whichever is chosen, the documents in §4 must end up saying the same thing the
   token actually permits.

G1 is **not** closed. G2 does not begin.
