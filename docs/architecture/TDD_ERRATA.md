# TDD v0.3 FINAL — Normative Errata

**Status: NORMATIVE.** Where this file and `TDD.md` disagree on a non-invariant concrete detail, **this file wins.**

`docs/architecture/TDD.md` is the frozen G0 baseline. Freezing it makes the historical baseline citable, but a frozen document cannot self-correct.

**This file does NOT amend invariants.** INV-01..INV-31 are changed only through the separate ADR + independent-review + operator-approval mechanism recorded in `docs/architecture/TDD_INVARIANT_AMENDMENTS.md`.

Once an invariant amendment is adopted, architecture reading order is:

1. `TDD_INVARIANT_AMENDMENTS.md` for amended invariants;
2. this `TDD_ERRATA.md` for concrete non-invariant corrections;
3. frozen `TDD.md` for everything not superseded.

A future agent MUST NOT resurrect superseded invariant wording merely because it still exists in the frozen TDD or a historical review.

**How to use this file.** Read it before treating any concrete non-invariant detail in `TDD.md` — a path, file name, diagram, number or implementation-mechanics claim — as binding. Each entry names what it corrects, what is true instead and the authority for the change.

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

**Authority:** GPT-PM, G1-M2 review (2026-09-10), `VERDICT: APPROVE`.

**See also:** `governance/GATE_MANIFEST_INTEGRITY.md`, `governance/plans/G1_REMEDIATION_PLAN.md`, `core/DECISION_LOG.md`.

---

## E-002 — §57's merge-authority mechanics are procedural, not mechanical

**TDD location:** §57 "Enforced governance mechanics", items 1 and 3: "Protected `main` branch; Claude has no direct merge permission" and "Merge and production deployment require operator-controlled identity/token."

**What the TDD says:** `main` is platform-protected against Claude merging it at all, and merge requires a separate operator-controlled credential Claude's implementation session does not hold.

**What is true instead:** measured against the live repository controls recorded in `governance/GATE_MANIFEST_INTEGRITY.md` and `core/RISK_REGISTER.md`, separation is procedural rather than guaranteed by a separate credential. Global `~/.claude/CLAUDE.md` §24 defines the conditions under which an ordinary PR merge may be performed after exact-head GPT-PM approval and green required checks.

**Why this matters as an erratum rather than a footnote.** A future session reading §57's concrete "protected, no direct merge permission" language literally would conclude a control exists that does not, understating the actual procedural risk.

**Authority:** GPT-PM, G1 closure review/remediation, 2026-09-12.

**See also:** `governance/GATE_MANIFEST_INTEGRITY.md`, `core/RISK_REGISTER.md` R12/R13, `core/DECISION_LOG.md`.

---

## Superseded figures recorded elsewhere, not duplicated here

Two G0 findings correct numbers the TDD relies on. They are already recorded, with live sources and fetch dates, in `docs/architecture/EXTERNAL_ASSUMPTIONS.md` and `core/adr/ADR-011-queue-consumer-runtime.md`:

- the Free-plan Queue-consumer CPU figure is unpublished/contradictory, so the conservative measured assumption remains the answer of record;
- D1 Free allows only 50 queries per Worker invocation, so candidate selection must not use per-candidate query loops.

If a future correction changes an invariant rather than a figure/detail, it belongs in `TDD_INVARIANT_AMENDMENTS.md`, not this file.
