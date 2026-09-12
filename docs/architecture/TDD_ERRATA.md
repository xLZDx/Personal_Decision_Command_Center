# TDD v0.3 FINAL — Normative Errata

**Status: NORMATIVE.** Where this file and `TDD.md` disagree, **this file wins.**

`docs/architecture/TDD.md` is adopted verbatim and frozen (G0 output A). Freezing it is what makes
it citable — but a frozen document cannot self-correct, and a later gate that finds one of its
details wrong has only two honest options: edit the frozen baseline, or record the correction
somewhere that is read alongside it. This is that place.

**Nothing here changes an invariant.** INV-01..INV-31 (TDD §5) are untouched by every entry below
and may not be amended by this file. Errata cover implementation detail: repository layout, file
names, and figures that turned out to be wrong or that a gate's own findings superseded.

**How to use this file.** Read it before treating any concrete detail in `TDD.md` — a path, a file
name, a diagram, a number — as binding. Each entry names the TDD location it corrects, what the
TDD says, what is true instead, and the authority for the change. An entry may be added only by a
gate that carries an explicit GPT-PM ruling for it, and the ruling must be quoted.

---

## E-001 — Governance CI is ONE workflow, not two

**TDD location:** repository tree, around `TDD.md` line 2265 — lists
`.github/workflows/gate-scope.yml` and `.github/workflows/policy-integrity.yml` as separate files.
Also §57(9), which speaks of "gate-scope CI failure".

**What the TDD says:** manifest-hash verification and gate-scope enforcement live in two workflow
files.

**What is true instead:** both live in a single workflow, `.github/workflows/governance.yml`, as
sequential steps of **one job**: resolve gate → verify manifest sha256 → check changed paths. The
check formerly called `gate-scope` is now the third step of the `Governance` check; a required
status check configured on `main` must be named `Governance`.

**Why — this is the important half of the entry.** The two-file layout is not merely a different
arrangement, it is the layout that produced defect **G1-M2**. Split across two `pull_request`
workflows with `needs: []`, nothing sequenced them, so the scope check validated a diff against a
manifest whose hash had never been verified — the diff could have rewritten the very document
authorizing it. That is the NM3 circularity the v0.2 adversarial review raised and that
`governance/GATE_MANIFEST_INTEGRITY.md` was written to close. Worse, `gate-scope.yml`'s own header
comment asserted the ordering it did not have, so the code read as correct.

**Do not restore the two-file layout by following the TDD's tree.** That is the specific regression
this entry exists to prevent, and it is the reason GPT-PM asked for this file rather than accepting
the deviation as a footnote.

**Authority:** GPT-PM, G1-M2 review (2026-09-10), `VERDICT: APPROVE`. Verbatim:

> По решению B: не требую менять frozen TDD в этой remediation. Один workflow вместо двух — это
> исправление реализации governance-механизма, а не изменение product architecture/invariant.
> Правильно оставить v0.3 frozen и зафиксировать deviation в GATE_MANIFEST_INTEGRITY.md +
> DECISION_LOG.md, как сделано. Но перед G1 final closure я хочу маленький normative
> erratum/addendum, чтобы будущий Claude не воскресил два workflow, просто следуя старому
> repo-tree в TDD. Сам frozen TDD переписывать сейчас не надо.

**See also:** `governance/GATE_MANIFEST_INTEGRITY.md` (the mechanism and its stated limits),
`governance/plans/G1_REMEDIATION_PLAN.md` (the remediation), `core/DECISION_LOG.md` (2026-09-10).

---

## E-002 — §57's merge-authority mechanics are procedural, not mechanical

**TDD location:** §57 "Enforced governance mechanics", items 1 and 3 (around line 2428-2430):
"Protected `main` branch; Claude has no direct merge permission" and "Merge and production
deployment require operator-controlled identity/token." Also line 2408, the "Claude MUST NOT" list:
"merge protected main."

**What the TDD says:** `main` is platform-protected against Claude merging it at all, and merge
requires a separate operator-controlled credential Claude's implementation session does not hold.

**What is true instead:** measured against the live ruleset `PDCC` on `main`
(`governance/GATE_MANIFEST_INTEGRITY.md` §1, `core/RISK_REGISTER.md` R12/R13, both current as of
2026-09-11): `required_approving_review_count` is **0** and `require_code_owner_review` is
**false**. No platform control requires human approval before a merge, CODEOWNERS review is not
enforced, and the implementer's own GitHub credential carries `admin` on this repository — it
technically _can_ merge. Separation between implementer and operator is procedural (the
implementer's compliance plus the audit trail in `core/DECISION_LOG.md`), not mechanical — R13's
own binding resolution, worded so no document in this repository may claim otherwise.

`~/.claude/CLAUDE.md` §24 (2026-09-11) narrows this further, not by weakening it: Claude MAY
perform an ordinary PR merge, but only when a genuine, correlated GPT-PM `VERDICT: APPROVE` names
the exact final head, every required check is green, and the PR is mergeable. This is a real
mechanism that has actually executed on this repository (PR #13, #14, both merged by Claude under
exactly this condition, 2026-09-11/12) — it is not a hypothetical relaxation. §24 originally also
excluded an authority-surface class (gate manifests, operator-approvals, branch-protection/ruleset
config, CODEOWNERS) from this mechanism, requiring an operator merge instead — that carve-out was
removed globally on 2026-09-12, by direct operator instruction, after it cost the operator a manual
merge on PR #15 (`~/.claude/core/DECISION_LOG.md` D-005). That class now merges under the same
conditions as any other PR.

**Why this matters as an erratum rather than a footnote.** A future session reading §57's concrete
"protected, no direct merge permission" language literally would conclude a control exists that
does not, understating the actual (procedural) risk and potentially deferring to a document instead
of verifying live state — exactly the failure mode `~/.claude/CLAUDE.md` §3/§23 exist to prevent.
INV-01..INV-31 are untouched: this entry corrects an implementation-mechanics claim, not an
invariant, and does not authorize anything beyond what §24 already independently establishes.

**Authority:** GPT-PM, G1 closure review (2026-09-12), `VERDICT: BLOCKER` (1) + `MAJOR` (3),
remediation plan `VERDICT: APPROVE`. Verbatim, on the wording gap this entry closes:

> MAJOR | claim | R13 is marked CLOSED on a condition that the live repository still violates:
> multiple current documents/tests still present CODEOWNERS/merge authority as mechanical
> enforcement. ... The frozen TDD still says "Protected main; Claude has no direct merge
> permission" and "Merge … require[s] operator-controlled identity/token," while the current errata
> contains only E-001 and does not correct this R13 reality. ... required change | Reconcile every
> present-tense live claim ... Since TDD.md is frozen, add a normative erratum for the concrete §57
> enforcement model rather than silently leaving the contradiction.

**See also:** `governance/GATE_MANIFEST_INTEGRITY.md` §1 (the measurement), `core/RISK_REGISTER.md`
R12/R13, `~/.claude/CLAUDE.md` §24, `core/DECISION_LOG.md` (2026-09-12).

---

## Superseded figures recorded elsewhere, not duplicated here

Two G0 findings correct numbers the TDD relies on. They are not restated as errata entries because
they are already recorded, with their live sources and fetch dates, in
`docs/architecture/EXTERNAL_ASSUMPTIONS.md` and `core/adr/ADR-011-queue-consumer-runtime.md`:

- **The Free-plan Queue-consumer CPU figure is unpublished, and Cloudflare's own pages contradict
  each other three ways** (§16.1/§16.2/§65). The conservative ~10 ms assumption stands; measurement
  is the answer of record, and it is a blocking G2 preflight item.
- **D1 Free allows only 50 queries per Worker invocation** — a second ceiling absent from §65.
  Candidate selection must be one batched query, never a per-candidate loop. Binding on G2.

If either later turns out to change an invariant rather than a figure, it becomes an entry here.
