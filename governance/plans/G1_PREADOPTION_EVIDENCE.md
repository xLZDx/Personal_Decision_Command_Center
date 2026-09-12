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

**FACT.** Branch `gate/g1-hash-control`, base `origin/main` @ `63a5425` (the tip at the moment the
branch was created; `005b8e6` is PR #10's own merge commit, not its base — corrected here after
GPT-PM's round-1 review of this section found the two conflated). PR #10. Run `34654217044`
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

**FACT.** Branch `gate/g1-forbidden-control`, base `origin/main` @ `005b8e6` — one commit ahead of
the `63a5425` the branch-creation approval named explicitly, that one commit being PR #10's own
merge (§12.1), which the same GPT-PM exchange had just approved. A documented base deviation, not a
claim that the exact-base approval literally covered this branch's actual creation point; the
technical control evidence below is unaffected by which of the two commits the branch started from,
since neither touches `governance/operator-approvals/**`. PR #11 (closed
unmerged). Commit `998831d` appended one line to `governance/operator-approvals/README.md`, which
`g1.yaml` lists under `forbidden_paths`. Run `34654474743` (REFUSE):

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
The restored-green state was then verified on a **separate** run, `34654532030` (Governance,
success) at head `ad2a407ebbc804964e5cc24326bfbaf5f5943fe9` — not the same run id as the REFUSE
above; the two runs were confirmed distinct via
`gh api repos/xLZDx/Personal_Decision_Command_Center/actions/runs?per_page=20` filtered by that
head SHA. PR #11 was closed **unmerged** — `main` was never touched by this branch.

### 12.3 Test-deletion guard, deletion half

**FACT.** Branch `gate/g1-deletion-control`, base `origin/main` @ `005b8e6` — same base deviation as
§12.2, same reason: created after PR #10 merged, one commit ahead of the named `63a5425`. PR #12
(closed
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
| `forbidden_paths`           | REFUSE and restored PASS | §12.2, REFUSE run `34654474743`, restored-PASS run `34654532030` (distinct runs)              |
| Test-deletion (delete half) | REFUSE                   | §12.3, run `34654709448` — restoration not applicable, the file was never deleted from `main` |

Every mechanical control this negative-control campaign exercised (§11, §12.1–§12.3) has now been
observed refusing at least once, on a real CI run, with the exact log line quoted above it rather
than paraphrased — three of the four refusals in the `governance` job (scope, hash mismatch,
`forbidden_paths`), the fourth (test-deletion's deletion half) in the separate `verify` job, as
noted in §12.3. This does not extend to every mechanical control the whole workflow can in
principle produce, only to the ones these four PRs (§11's PR #7, §12.1's PR #10, §12.2's PR #11,
§12.3's PR #12) were built to exercise.

Of those four, **PR #11 and #12 were closed unmerged and never touched `main` at all** — each
existed solely to produce the CI evidence quoted above. **PR #10 was merged** (base `63a5425`,
merge commit `005b8e6`), and its only durable content is the 49-line `core/DECISION_LOG.md` entry
recording the hash-mismatch result — it did not carry the `.gitignore`/`.dev.vars` kind of
instrument the other controls used, so nothing beyond that entry reached `main` through it. PR #7
is different again: it was also merged, and it legitimately carries real content beyond a
decision-log line — the report-correction
pair and a decision-log wording fix (§11 above). Its `.gitignore` scope-refusal instrument was
reverted before merge, but the rest of its diff is intended, durable change, not a side effect to
minimize. This paragraph is scoped to these four negative-control PRs; it is not a claim about the
whole G1 history.

## 13. Operator boundary — nothing below is the implementer's

Note the change §3.1 makes to this list. These are not operator-only because the implementer
_cannot_ do them; the credential now can. They are operator-only because they are the authority the
whole mechanism is built on, and an implementer that adopts its own manifest and sets its own
approval hash has authorized itself. The boundary is held by choice, and saying so is the point.

1. ~~Adopt an authoritative `governance/gate-manifests/g1.yaml`~~ — **authoring delegated and
   done** (§9). At this step what existed was only a candidate; adoption (setting the approval
   hash) was completed at step 2, below — now also done.
2. ~~Read the candidate, then set `GATE_MANIFEST_APPROVED_HASH_G1`~~ — **done 2026-09-11** (§10).
   The operator read the bytes, agreed, and adopted them; the variable is set and the scope check
   passes. Read §10.1 before treating this as a fully mechanical separation: it is not one yet.
3. ~~Merge PR #1~~ — **done 2026-09-11** (`mergedAt` confirmed via `gh pr view 1`).
4. ~~`gh auth login`~~ — **done**, by the operator, during an earlier plan.
5. ~~Decide and apply branch protection (§6)~~ — **done 2026-09-11**, ruleset `PDCC`
   (`core/RISK_REGISTER.md` R12).
6. ~~Decide the credential model of §3.1~~ — **decided 2026-09-11** (`core/RISK_REGISTER.md` R13):
   no second GitHub identity; separation is procedural, not mechanical, and no document in this
   repository may claim otherwise.

**This section's own six items are now all resolved.** That closes the specific list of operator
actions this section tracked — it is not itself a G1 closure verdict. G1 closes on its own
fresh-context review and a `G1_CLOSURE_REPORT.md`, not by this checklist alone reaching zero
remaining rows.

## 14. `g1.yaml`'s own `status:` field is stale, and deliberately left that way

**FACT, found during the fresh-context closure review (2026-09-12).** The manifest's `status:`
field still reads
`OPERATOR_DIRECTED_IMPLEMENTER_AUTHORED_CANDIDATE_AWAITING_OPERATOR_REVIEW_AND_HASH` — a
pre-adoption label, even though the operator reviewed and adopted it on 2026-09-11 (§10). This is
not fixed here, and should not be: `governance/gate-manifests/**/*.yaml` is the manifest's own
first `forbidden_paths` entry (INV-28), so an implementer edit to this field — however cosmetic —
would be exactly the self-authorization loop that entry exists to prevent, regardless of how
narrow the edit looks.

**What actually makes the manifest binding is unaffected by this field.** `governance.yml`'s hash
step checks the file's `sha256sum` against the operator-controlled `GATE_MANIFEST_APPROVED_HASH_G1`
repository variable — it never reads `status:`, `plan_hash`, or any other field's content (the
manifest itself says as much: "the checker reads `allowed_paths` and `forbidden_paths` and NOTHING
ELSE"). A stale status string sitting next to a correct, matching hash is inert to the mechanism;
it is only misleading to a human reader who assumes the label reflects reality.

**Disposition:** accepted as MINOR documentation debt, listed here rather than silently left
unexplained. If the operator wants the label corrected, that is a manifest edit and needs the same
review-and-rehash ceremony as any other change to this file — not a routine implementer fix.

## 15. Fresh-context closure review, round 1: BLOCKER + 3 MAJOR, all independently verified and fixed

**A fresh-context G1 closure request (2026-09-12), asking GPT-PM to re-verify the whole gate
against live state rather than any earlier round's summary, returned `VERDICT: BLOCKER`** with one
BLOCKER and three MAJOR findings. Each was independently re-verified against a primary source
before any fix began (per `~/.claude/CLAUDE.md` §3/§23 — a reviewer's finding is a claim to check,
not an instruction to act on unread), and every citation below is the file/line/command that
verification actually used, not GPT-PM's own wording repeated back.

**BLOCKER — the "Gate: NONE" ungated PR path could edit its own enforcement.** Read directly from
`scripts/verify/check-floor-scope.mjs`: `FORBIDDEN_PATHS` listed
`governance/gate-manifests/**`, `governance/operator-approvals/**`, `docs/architecture/TDD.md`,
`.github/workflows/**`, `.github/CODEOWNERS` — and did **not** list `scripts/verify/**`, even
though `.github/CODEOWNERS` already declared `/scripts/verify/ @xLZDx` operator-owned and
`tests/policy/codeowners.test.mjs`'s `OPERATOR_OWNED` list included it too. Because
`governance.yml` runs `node scripts/verify/check-floor-scope.mjs` from the PR's own checkout, an
ungated ("Gate: NONE") PR editing that file to drop its own forbidden entry would have its EDITED
version executed by CI, with nothing catching the edit — a self-modification hole, not merely a
missing path. **Fix:** removed the "Gate: NONE" path entirely rather than patching the floor's
forbidden list (patching would have left the same self-modifying-enforcement-code property intact
for whatever the floor still allowed). Every PR now must resolve to a real adopted gate
(`gate/g<N>-...` branch or a `Gate: G<N>` body line) or `governance.yml`'s gate-resolution step
fails immediately, before any PR-controlled scope code executes at all.
`scripts/verify/check-floor-scope.mjs` deleted; `tests/policy/floor-scope.test.mjs` rewritten (per
GPT-PM's own remediation-approval instruction, not deleted) into a static regression suite proving
the source no longer contains the removed path; the 4 corresponding entries in
`scripts/verify/mutation-check.mjs` removed as dead weight. §16 below will record the real CI
negative-control run ids proving a no-gate PR is refused, once `control/g1-none-rejection`'s two
attempts have actually run after this remediation merges — not yet, and not part of this round's
evidence.

**MAJOR — CODEOWNERS and its test still claimed mechanical enforcement R13 had already
disclaimed.** `.github/CODEOWNERS`'s own header said "This file is the control that actually
enforces the governance invariant... CI checks are detection, merge authority is enforcement" and
"G1's DoD requires evidence that it is actually on"; `tests/policy/codeowners.test.mjs`'s docstring
said "CODEOWNERS is the only control that actually enforces the governance invariant (merge
authority; CI is detection)." Both directly contradicted `core/RISK_REGISTER.md` R13's own binding
resolution ("no document in this repository may claim that CODEOWNERS... mechanically separates
implementer from operator") and the live, measured ruleset state
(`require_code_owner_review: false`, `required_approving_review_count: 0`). **Fix:** both files
corrected to state plainly that CODEOWNERS currently declares intended ownership without
mechanically enforcing it; `docs/architecture/TDD_ERRATA.md` gained **E-002**, correcting TDD §57's
"protected main, no direct merge permission" claim against the same measurement, and recording that
`~/.claude/CLAUDE.md` §24's narrow merge mechanism is a real, already-executed one (PR #13, #14).
Project `CLAUDE.md` and `AGENTS.md` also corrected: both previously said "merge protected main"
unconditionally forbidden to Claude, which was stale against §24's mechanism already in active use
this session.

**MAJOR — several operating documents were still describing a G0-in-progress, no-code,
no-manifest repository.** Confirmed stale, each against its own primary source: project `CLAUDE.md`
line 58 ("Current state: G0 in progress"); `AGENTS.md` line 52 ("No code exists yet — this
repository is at gate G0"); `governance/gate-manifests/README.md` line 15 ("No manifest exists
yet"); `core/PLAN_MASTER_GATES.md`'s G0-section note on item O, still describing `forbidden_paths`
and the hash-mismatch control as "have still never run." All four corrected to current state (the
`PLAN_MASTER_GATES.md` note kept as an explicitly-labeled historical quote rather than deleted,
since it was a real, dated observation at G0's own closure). `governance/gate-manifests/g1.yaml`'s
own stale `status:` field was found in the same pass and is **not** part of this fix — §14 above
records why it is left alone and accepted as MINOR debt instead.

**MAJOR — 5 npm audit findings with no matching risk-register disposition.** `npm audit --json`
confirmed exactly GPT-PM's citation: 3 moderate, 1 high, 1 critical, all in the
`vitest`/`vite`/`esbuild` chain; `package.json` has no `dependencies` section at all (not an empty
one — `node -e "console.log(require('./package.json').dependencies)"` prints `undefined`), and
`vitest` is a `devDependencies` entry. **Fix:** `core/RISK_REGISTER.md` R14 added, stating the
disposition precisely — not shipped as production runtime dependencies, but a real dev/CI-runner
exposure, not "non-reachable" — with an explicit G8 exit condition (upgrade to `vitest` 5.x, a
semver-major bump not taken in this remediation, or re-accept with fresh evidence).

**What this section does NOT claim.** These four fixes close exactly the findings GPT-PM's BLOCKER
review named — they are not a second, broader documentation sweep, and any other stale claim found
later belongs to whichever gate discovers it, per this project's own "one sweep per gate" review
discipline (`~/.claude/CLAUDE.md` §17).

## 16. Real CI negative control: no-gate PR rejected at gate resolution

**FACT.** Branch `control/g1-none-rejection`, base `main` @ `8980301` (PR #15's actual merge commit
— confirmed via `git merge-base main control/g1-none-rejection`, distinct from `ab51f71`, which is
the PR #15 branch's own last commit before GitHub's merge commit was created). Carries the
BLOCKER+3-MAJOR remediation from §15. PR #16, deliberately declaring no gate: the
branch name does not match `gate/g<N>-...` and the PR body carries no `Gate: G<N>` line. Branch
creation authorized the same way as §12's three controls — GPT-PM `VERDICT: APPROVE` under §20,
naming this branch by name/base/purpose, since branch creation is reversible.

**Attempt A — ordinary path.** The control instrument was `README.md` (a stale "G0 in progress"
status line already due for correction, per §15's third MAJOR); the same commit (`7ec0f24`) also
recorded the attempt in `core/DECISION_LOG.md` — the commit is not README-only, only the
instrument is. Run `34679875903`, job on `governance`:
step 4 ("Resolve the gate this PR belongs to") failed immediately, verbatim:

```
::error::This PR declares no gate. Name the branch gate/g<N>-... or put a
::error::'Gate: G<N>' line in the PR body. A change with no declaration has no
::error::approved scope, which is the thing this check exists to require.
```

No manifest-hash step and no scope step ran — the failure is at gate resolution itself, before any
PR-controlled scope code executes.

**Attempt B — touching the enforcement code's own path.** A second commit on the same branch
(`2ce8388`) additionally added a harmless comment to `scripts/verify/check-gate-scope.mjs` — the
scope checker itself — with no functional change. Run `34679958587`, job on `governance`: step 4
failed with the **identical** error text quoted above, at the same timestamp offset in the job
(`07:08:59`), before step 5 or step 6 ran. Confirmed via
`gh run view 34679958587 --log`, filtered to the "Resolve the gate this PR belongs to" step.

**Note on `main`'s own README.md.** The correction attempt A carried (fixing the stale "G0 in
progress" line) existed only on PR #16, which was intentionally closed unmerged — so it never
reached `main`. That correction is real and still due, but is **not** part of this branch's
authorized scope (GPT-PM round 2, `VERDICT: MAJOR`, caught an earlier attempt to fold it in here as
a scope excess and required a revert) — it belongs to whichever branch is actually authorized to
carry it, separately.

**What this establishes.** The removal of the "Gate: NONE" ungated path (§15's BLOCKER fix) refuses
an undeclared PR at the very first workflow step, unconditionally — including when the diff being
refused is a no-op edit to the enforcement script's own source. The refusal does not depend on
which path the diff touches; it depends only on the PR declaring no gate. This is the real-CI
demonstration that the self-modification hole GPT-PM found (an ungated PR editing
`scripts/verify/check-floor-scope.mjs`'s own forbidden-path list) cannot recur through the
successor mechanism, because there is no longer any path through gate resolution that reaches
PR-controlled code before failing.

**PR #16 was closed unmerged** after both attempts' refusal evidence was captured — its sole
purpose was producing the two CI runs quoted above; `main` was never touched by this branch.

| Attempt | Instrument                            | Run           | Result (step 4)         |
| ------- | ------------------------------------- | ------------- | ----------------------- |
| A       | `README.md` (ordinary path)           | `34679875903` | REFUSE                  |
| B       | `scripts/verify/check-gate-scope.mjs` | `34679958587` | REFUSE (identical text) |

## 17. Real CI negative control: `GATE_ACTIVE` unset, produced incidentally by this remediation's own PR

**FACT.** Not a deliberately staged control — the ordinary consequence of opening PR #19
(`gate/g1-lifecycle-fix`, base `main` @ `26d3df2`) for review before the operator has bootstrapped
the new `GATE_ACTIVE` variable this same PR introduces. Run `34687783026`, job `103537703713`, step
"Resolve the gate this PR belongs to" **failed**, verbatim:

```
##[error]GATE_ACTIVE is not set. The operator must set this repository variable
##[error]to the currently authorized gate label (e.g. G1) before any PR-declared
##[error]gate can be trusted -- a declared gate with no operator-controlled
##[error]active-gate binding has no enforced scope, regardless of that gate's
##[error]own manifest/hash still existing.
```

No hash step and no scope step ran — refused at gate resolution itself, exactly as designed. This
is the same bootstrap shape `GATE_MANIFEST_APPROVED_HASH_G1` already had: the mechanism fails
closed until the operator sets the corresponding repository variable, and this run is that failure
mode demonstrated on a real PR rather than only reasoned about. `verify` (the other required check)
passed independently (run `34687783023`) — the failure is isolated to the new gate-resolution
logic, not a broken build.

**Still open**: the mirror case — `GATE_ACTIVE` set but not matching the PR's declared gate (the
"may have been retired" message) — needs a deliberate control once `GATE_ACTIVE=G1` exists to set
away from and back to, per `~/.claude/CLAUDE.md` §25 (a wrong value only ever makes the gate
stricter). Not yet executed.
