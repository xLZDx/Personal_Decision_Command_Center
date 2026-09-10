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

Ranked by how hard each is to circumvent from an implementer branch. **Only the first is real
enforcement**; the rest are detection and friction.

### 1. Merge authority (the actual control)

- `main` is a protected branch. The implementer has no direct-push and no merge permission.
- A PR touching `governance/gate-manifests/**`, `governance/operator-approvals/**`,
  `.github/workflows/**`, or `core/SOURCE_POLICY.md` / `core/DATA_RETENTION_POLICY.md` requires
  review from `CODEOWNERS` — i.e. the operator — before it can merge.
- Consequence: even if every automated check below were disabled in the implementer's branch,
  nothing reaches `main` without the operator looking at it. This is the backstop that does not
  depend on CI behaving.

`.github/CODEOWNERS` (G1 deliverable):

```
/governance/gate-manifests/     @<operator>
/governance/operator-approvals/ @<operator>
/.github/                       @<operator>
/core/SOURCE_POLICY.md          @<operator>
/core/DATA_RETENTION_POLICY.md  @<operator>
/core/adr/                      @<operator>
```

### 2. Approved-hash comparison against out-of-tree state

The approved manifest hash is **not stored in the git tree**. It lives as a GitHub Actions
repository **variable** (`GATE_MANIFEST_APPROVED_HASH_<GATE>`), set through repository settings by
the operator. A branch cannot alter a repository variable by committing anything.

`policy-integrity.yml` (G1 deliverable) computes `sha256sum governance/gate-manifests/<gate>.yaml`
and fails if it differs from the variable. So:

- Operator adopts a manifest -> operator sets the variable to its hash -> CI passes.
- Implementer edits the manifest in a branch -> hash differs -> CI fails loudly, naming the file.
- Implementer reverts the edit -> CI passes again.

### 3. Scope check driven by the _verified_ manifest only

`gate-scope.yml` computes the PR's changed paths and validates them against
`allowed_paths`/`forbidden_paths` — but runs **only after** the hash check in (2) has passed, and
in the same job, so a tampered manifest can never be the one that authorizes the diff.

## What this mechanism explicitly does NOT protect against — stated, not glossed

An honest design says where its own guarantees stop.

1. **A modified workflow file in the PR branch.** For `pull_request` events, GitHub Actions runs
   the workflow definition as it exists in the PR's merge commit — so a PR that edits
   `.github/workflows/policy-integrity.yml` changes the very check that is supposed to police it.
   This is why control (1) is listed first and control (2) second: `.github/**` is CODEOWNERS-
   protected precisely because CI cannot police its own definition. Anyone reviewing a PR that
   touches `.github/**` must read that diff as a governance change, not as a build tweak.
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

## Verification owed at G1

- A negative test: a PR that edits `gate-manifests/<gate>.yaml` without the operator updating the
  variable **must** fail CI, demonstrated on a real PR, not asserted.
- A negative test: a PR touching a path outside `allowed_paths` must fail `gate-scope.yml`.
- Evidence that branch protection and CODEOWNERS review are actually enabled in repository
  settings (a screenshot or `gh api` output), not merely described in this file — a CODEOWNERS
  file with branch protection switched off is decoration.
