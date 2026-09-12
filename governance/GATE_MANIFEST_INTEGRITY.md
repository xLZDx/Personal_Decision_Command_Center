# Gate-Manifest Integrity Mechanism

**G0 output O — design.** Implementation lands at G1 (governance/CI gate); this file is the
design that G1 implements, and the thing `gov-01`/`red-01` review G1 against.

Closes NM3 from `reviews/02-tdd-v0.2-adversarial-review.md`. Governance invariant being
satisfied (TDD §57):

> The actor being constrained cannot modify the authoritative object that defines the constraint.

## The problem, stated precisely

Each gate has a binding `gate-manifests/<gate>.yaml` declaring `plan_id`, `plan_hash`,
`approved_scope`, `allowed_paths`, `forbidden_paths`, `required_tests`, `required_reviewers`,
`policy_sensitive_files`. CI then checks the gate's actual changed paths against
`allowed_paths`/`forbidden_paths`.

If the implementer can edit that manifest in their own branch, the check is circular: the diff is
validated against a document the same diff can rewrite. Widening `allowed_paths` by one line
silently legalizes any scope violation. That is not a hypothetical — it is the exact shape of the
finding the v0.2 adversarial review raised, and it survived an earlier review round before being
caught.

## What actually enforces, and in what order

Ranked by how hard each is to circumvent from an implementer branch.

**Corrected 2026-09-11:** this used to say "**Only the first is real enforcement**; the rest are
detection and friction", on the belief that merge authority was mechanically held by the operator.
Measurement says otherwise (see §1), and the ranking inverts:

- **Mechanically enforced by the platform:** a pull request is required, `governance` and `verify`
  must be green on the head being merged (strict), and deletion and non-fast-forward pushes are
  blocked. That is controls (2) and (3) below, plus the ruleset itself.
- **Procedural, resting on compliance and the audit trail:** who decides that a merge may happen —
  control (1). There is no mechanically enforced human separation.

So the first item is the one that is NOT mechanical, and the checks below it are. The order is kept
because it still ranks by consequence — a wrong merge decision is worse than a missed check — but it
no longer claims the first is enforcement.

### 1. Merge authority — procedural, NOT mechanical

**Corrected 2026-09-11 after R13 was closed as an accepted risk.** This section previously claimed
that the implementer has no direct-push and no merge permission, that a PR touching the protected
paths requires `CODEOWNERS` review before it can merge, and that "nothing reaches `main` without the
operator looking at it". **All three were false**, and they were the most load-bearing sentences in
this document. Measured on 2026-09-11 against ruleset `PDCC` (`22899342`), not recalled:

| Rule actually configured on `main`             | Value                           |
| ---------------------------------------------- | ------------------------------- |
| `required_status_checks`                       | `governance` + `verify`, strict |
| `pull_request.required_approving_review_count` | **0**                           |
| `pull_request.require_code_owner_review`       | **false**                       |
| `deletion`, `non_fast_forward`                 | blocked                         |

So: a PR is required and two checks must be green, deletion and force-push are blocked — those are
real. But **no human approval is required by the platform at all**, `CODEOWNERS` review is not
enforced, and the implementer's credential carries `admin` on this repository, so it _can_ merge.

**Approvals are 0 deliberately, and cannot simply be raised.** There is one GitHub identity
(`xLZDx`) behind both roles — R13, closed as an accepted risk by operator decision on 2026-09-11.
GitHub forbids approving one's own PR, so requiring even a single approval would deadlock every PR
the implementer opens. Raising this number is not a fix while one identity does both jobs.

**What the real control is, then.** Not the platform. The merge decision comes from an independent
review — GPT-PM reasoning over the exact final head, per `~/.claude/CLAUDE.md` §24 — and the
implementer performs the mechanical click as that decision's executor. The evidence that this
happened lives in `core/DECISION_LOG.md` and the PR's own review record, **not** in anything GitHub
enforces. Separation here is **procedural**: it rests on the implementer's compliance plus the audit
trail, and an auditor should read it that way.

**Binding consequence of R13's closure:** no document in this repository may assert that
`CODEOWNERS`, branch protection, or any procedure _mechanically_ separates implementer from
operator. Wording that implies it is a defect to correct on sight.

`.github/CODEOWNERS` (G1 deliverable):

```
/governance/gate-manifests/     @<operator>
/governance/operator-approvals/ @<operator>
/.github/                       @<operator>
/scripts/verify/                @<operator>
/core/SOURCE_POLICY.md          @<operator>
/core/DATA_RETENTION_POLICY.md  @<operator>
/core/adr/                      @<operator>
/docs/architecture/             @<operator>
/CLAUDE.md                      @<operator>
/AGENTS.md                      @<operator>
```

**The rule for this list: anything that can change what is binding belongs on it.** Two entries
exist because that rule was broken and then caught:

- `/scripts/verify/` — the workflow is a thin wrapper and the checks it runs live there. Protecting
  a check's definition while leaving its implementation open protects nothing.
- `/docs/architecture/` — `TDD_ERRATA.md` is normative and outranks `TDD.md` on concrete details,
  so whoever can edit it can change the binding architecture without touching any other protected
  path. GPT-PM found this in the G1-M2 review: the change created a new authority surface and left
  it outside the boundary it was itself tightening. `TDD.md` was unlisted too — a gap that predates
  the errata file; the directory covers both.

The list of operator-owned authority paths is asserted by `tests/policy/codeowners.test.mjs`, so an
entry cannot be dropped silently.

### 2. Approved-hash comparison against out-of-tree state

The approved manifest hash is **not stored in the git tree**. It lives as a GitHub Actions
repository **variable** (`GATE_MANIFEST_APPROVED_HASH_<GATE>`), set through repository settings by
the operator. A branch cannot alter a repository variable by committing anything.

`.github/workflows/governance.yml` (G1 deliverable) computes
`sha256sum governance/gate-manifests/<gate>.yaml` and fails if it differs from the variable. So:

- Operator adopts a manifest -> operator sets the variable to its hash -> CI passes.
- Implementer edits the manifest in a branch -> hash differs -> CI fails loudly, naming the file.
- Implementer reverts the edit -> CI passes again.

### 3. Scope check driven by the _verified_ manifest only

`scripts/verify/check-gate-scope.mjs` computes the PR's changed paths and validates them against
`allowed_paths`/`forbidden_paths` — as a later **step of the same job**, so it is unreachable
unless the hash check in (2) exited 0. A tampered manifest can therefore never be the one that
authorizes the diff.

**This was implemented wrongly the first time, and the wrong version claimed to be the right one.**
The original G1 code split (2) and (3) into `policy-integrity.yml` and `gate-scope.yml` — two
independent `pull_request` workflows, `needs: []` — while `gate-scope.yml`'s own header comment
asserted it ran "only after policy-integrity has confirmed the manifest is the operator-approved
one". Nothing sequenced them, so the scope check read a manifest whose hash nothing had verified:
exactly the circularity NM3 describes, reintroduced by the file layout. GPT-PM's G1 review caught
it as **G1-M2**. The two workflows are now one.

**Divergence from the adopted TDD, recorded rather than hidden.** `docs/architecture/TDD.md`'s
repository tree (§ around line 2265) lists `gate-scope.yml` and `policy-integrity.yml` as separate
files, and §57(9) speaks of "gate-scope CI failure". That tree is illustrative layout, not one of
the INV-01..INV-31 invariants, and it is precisely the layout that produced G1-M2. The frozen TDD
is not edited; the deviation is recorded here, in `../core/DECISION_LOG.md`, and — normatively —
as entry **E-001** in `../docs/architecture/TDD_ERRATA.md`, which GPT-PM required so that a future
session cannot recreate the two-workflow split simply by following the TDD's repository tree.

#### Pattern grammar, which is narrower than shell globbing

The first implementation matched with bash `[[ "$path" == $pattern ]]`, where `*` crosses `/`.
Under that rule `allowed_paths: [packages/*]` silently authorized `packages/anything/deep/file.ts`
— a manifest reading as "the top level of packages" that in fact authorized the whole subtree.
The current matcher is segment-bounded:

| Pattern | Means                                                |
| ------- | ---------------------------------------------------- |
| `**`    | a whole segment; matches any number of path segments |
| `*`     | matches within ONE segment only; never crosses `/`   |
| other   | literal, including `.`                               |

Note what the vacuity warning does and does not catch: it fires on the literal entry `**` only.
A near-universal pattern written another way — `**/*`, for instance — is not flagged. Since the
manifest's content is fixed by the hash check before any diff is evaluated against it, an
implementer cannot introduce one **without the operator re-approving the changed bytes and updating
the variable**; this is a gap in the operator-facing warning, not a bypass. **Corrected
2026-09-11:** this previously credited "CODEOWNERS review plus the hash check". CODEOWNERS review
contributes nothing mechanical — `require_code_owner_review` is `false` on the live ruleset (§1).
The hash check alone is what closes this, and it closes it only because the approved hash lives
outside the tree.

Patterns are anchored at both ends, are repository-relative, and may not contain `\`, `//`, `.`
or `..` segments. `**` glued to other characters in a segment (`a**b`) is rejected as ambiguous
rather than guessed at. A manifest whose `allowed_paths` contains a bare `**` matches everything;
that is reported as a `::warning::` on every run, because a check that cannot refuse anything
should not look like a check that passed.

The manifest is read by a deliberately tiny YAML-subset reader, not a YAML library: a gate
manifest is a governance document a human audits and hash-approves, so anchors, aliases, block
scalars, flow style, duplicate keys and nested mappings are **rejected outright** rather than
silently honored, and a key the reader cannot parse is an error, never an empty list. A key that
is present but declares no entries is also an error: an empty list read from a key that is
physically there cannot be told apart from a list the reader failed to read.

#### A defect this reader had, found by internal review before the change was committed

The first version of the reader ended a block at **any** non-indented line. A list item that lost
its indent —

<!-- prettier-ignore -->
```text
forbidden_paths:
- secrets/**
```

(note the missing indent on the second line, which is the entire defect) — therefore took the
"next top-level key" branch, and `parsePathList` returned an empty list with
no error at all. For `forbidden_paths` that is silently zero enforcement, and it is invisible,
because an empty list is exactly what a manifest declaring no forbidden paths produces. The
manifest still reads correctly to a human, so the operator's hash approval — the control this
whole mechanism rests on — would have been given to a file that enforced nothing.

A non-indented line now ends the block only if it actually matches a top-level `key:` shape;
anything else raises the same error as any other malformed entry. This is recorded because the
mechanism's credibility depends on its failure modes being written down, not only its features.

#### What is actually verified, stated narrowly

`tests/policy/gate-scope.test.mjs` (39 tests) and `npm run verify:mutation` (30 mutations, all
killed; 20 of them target this guard, and every one makes it refuse **less**) cover:

- `compilePattern` — segment bounding, anchoring, metacharacter escaping, and the rejected
  pattern shapes;
- `parsePathList` — duplicate keys, flow style, unindented items, present-but-empty keys, YAML
  aliases and anchors, block scalars, malformed lines;
- `run` — the exit code for every path: in-scope diff, out-of-scope path, forbidden path, missing
  environment variable, unreadable manifest, manifest with no `allowed_paths`, malformed manifest,
  failed `git diff`, allow-everything manifest, empty diff;
- `changedPathsFrom` — against a real temporary git repository, including filenames containing a
  space and non-ASCII characters, which is the case `-z` exists for.

That list is deliberately explicit rather than summarised as "the check is tested". An earlier
draft of this section claimed the matcher and reader were mutation-tested while `run` — the only
function CI actually executes, and the one whose exit code IS the control — had no test of any
kind. A guard that computes violations correctly and then exits 0 provides nothing, and no test
would have noticed.

This used to matter more than usual, because remote CI on this repository executed nothing (R11).
**No longer true as of 2026-09-11:** R11 is resolved — the repository is public, so Actions are free
and unmetered, and `governance` and `verify` both run and pass on every PR head (measured on PR #6,
head `fa2917b`). Local test and mutation evidence is now corroboration rather than the only evidence
this control has.

## What this mechanism explicitly does NOT protect against — stated, not glossed

An honest design says where its own guarantees stop.

1. **A modified workflow file in the PR branch.** For `pull_request` events, GitHub Actions runs
   the workflow definition as it exists in the PR's merge commit — so a PR that edits
   `.github/workflows/governance.yml` changes the very check that is supposed to police it. The
   same applies to `scripts/verify/check-gate-scope.mjs`, which that workflow executes. This is
   why control (1) is listed first and control (2) second: `.github/**` is listed in `CODEOWNERS`
   precisely because CI cannot police its own definition. Anyone reviewing a PR that touches
   `.github/**` or `scripts/verify/**` must read that diff as a governance change, not as a build
   tweak. Both paths are listed for exactly this reason — `scripts/verify/` was added when the
   scope check moved into it, since protecting a check's definition while leaving its
   implementation unprotected protects nothing. **Corrected 2026-09-11:** this used to say both
   paths are "CODEOWNERS-protected". They are not protected by the platform — ruleset `PDCC` has
   `require_code_owner_review: false` (see control 1). `CODEOWNERS` here is a **map of what must be
   read as a governance change**, not an enforced gate.
2. **Anything before a push.** These controls govern what reaches `main`. They say nothing about
   the local working tree, and nothing about a session that edits files without ever pushing.
3. **The operator's own machine-level hooks** (`~/.claude/hooks/*`) are outside this repository
   and unversioned — a known, already-documented gap in the global operating contract. They are
   not part of this mechanism and must not be cited as if they were.
4. **A compromised operator account.** Out of scope; if the account that grants approvals is
   compromised, no in-repo mechanism helps.
5. **G0 itself has no manifest** — by design. G0 is the gate that produces this mechanism, so it
   cannot be governed by it without the same circularity. G0's constraint is the kickoff prompt's
   explicit scope list plus operator/GPT-PM review of the G0 closure request. First manifest-
   governed gate is G1.
6. **Which gate a PR claims to be is implementer-controlled.** The gate is read from the branch
   name or the PR body, so once several gates have approved manifests, a PR could declare the
   gate whose manifest is most permissive and both checks would pass: the hash matches (that
   manifest was not touched) and the paths are inside it. What this mechanism actually proves is
   therefore _"this diff fits **some** manifest the operator approved"_, not _"this diff fits the
   manifest for the gate genuinely in progress."_ Closing it needs the gate binding to come from
   operator-controlled state too — a per-gate repository variable naming the currently open gate,
   or the approval record in `operator-approvals/`. Not implemented, and **nothing mechanical
   covers it today**: this used to say "the operator reading the gate label on the PR they are
   approving" covers it, but the platform requires no approval at all
   (`required_approving_review_count: 0`), so no one is obliged to read anything. What covers it in
   practice is the independent review under `~/.claude/CLAUDE.md` §24 naming the exact head — which
   is a procedure, not an enforcement.
7. **The manifest's own `plan_id` / `plan_hash` are not verified against anything.** The hash
   check proves the manifest file is byte-identical to what the operator approved. It does not
   check that `plan_hash` matches the plan file in `plans/`, so an approved manifest can point at
   a plan that has since changed. The operator adopting the manifest is what binds those today.

## Verification owed at G1

- A negative test: a PR that edits `gate-manifests/<gate>.yaml` without the operator updating the
  variable **must** fail the `Governance` check, demonstrated on a real PR, not asserted.
- A negative test: a PR touching a path outside `allowed_paths` must fail the same check — and it
  must fail at the scope step, having reached it only because the hash step passed.
- Evidence from `gh api` — not a screenshot and not this file's word — of what the ruleset on
  `main` actually enforces. **DONE 2026-09-11**, and the answer is the one §1 now records: ruleset
  `PDCC` (`22899342`) is active with strict `governance` + `verify`, deletion and non-fast-forward
  blocked, `required_approving_review_count: 0`, `require_code_owner_review: false`. This bullet
  used to ask for evidence that "CODEOWNERS review is enabled"; it is **not** enabled, and asking
  for evidence of a control that does not exist is how a document ends up asserting one. `CODEOWNERS`
  here is a map of governance-bearing paths, not a gate.

**Status, rewritten 2026-09-11 — the blocker described here is gone.** This section used to say none
of the three could be produced: GitHub Actions started no jobs at all (run `34513131209` for
`b784265` finished in four seconds with zero steps, annotated _"The job was not started because
recent account payments have failed or your spending limit needs to be increased."_), and branch
protection on a **private** repository needs a paid plan (`/branches/main/protection` returned 404).

Both were operator decisions, and the operator settled them with one move: **the repository is now
public.** Actions are free and unmetered for public repositories, and rulesets are available on Free
— so **R11 and R12 are both resolved**, and `governance` and `verify` genuinely run and pass on every
PR head. What remains is narrower than "the enforcement is unverified":

| Owed                                                                  | Status                                                                                                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ruleset evidence from `gh api`                                        | **DONE** — see the bullet above                                                                                                                      |
| Negative test: manifest edited without the variable updated must fail | **DONE** — `governance/plans/G1_PREADOPTION_EVIDENCE.md` §12.1, run `34654217044`, hash mismatch refused before scope ran                            |
| Negative test: out-of-scope path must fail, at the scope step         | **DONE** — `governance/plans/G1_PREADOPTION_EVIDENCE.md` §11, run `34640409639`, `.gitignore` refused while 3 in-scope paths in the same diff passed |

So the honest statement of this mechanism's status is now: **the matcher and the manifest reader are
verified (unit tests + mutation testing); the hash step has been observed both refusing and passing;
the scope step has been observed both refusing (§11) and passing (§10) — the same mechanism answering
both ways, with nothing changing between the two observations except the diff's content.**
