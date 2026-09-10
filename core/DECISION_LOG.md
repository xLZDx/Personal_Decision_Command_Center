# Decision Log

Durable decisions and evidence future gates need. Not for routine narration (global CLAUDE.md §8).
Newest entries at the top.

---

## 2026-09-10 — G0 CLOSED (GPT-PM APPROVE); G1 held; CI is blocked by GitHub billing

**Decision:** G0 is closed. GPT-PM returned `VERDICT: APPROVE, 0 BLOCKER, 0 MAJOR` and ruled that
G0 closes **without** the empirical CPU probe having run — the design already assumes the most
conservative reading, so the probe can only widen the budget, never invalidate the architecture.
R8/R9/R10 transfer to G2 as **blocking preflight** items (`G2-PREFLIGHT-01/02/03`), not as
someday-work. ADR-002/003/005/007/008/009/010 → ADOPTED; ADR-011 → ADOPTED WITH R8/R9 OPEN; threat
model → REVIEWED AND ADOPTED via GPT-PM's fresh-context SEC/PRIV pass. Full record:
`governance/G0_CLOSURE_REPORT.md`.

**G1 is NOT closed and was never an authorized gate.** GPT-PM: REJECT/HOLD, two BLOCKERs and three
MAJORs, all accepted. Commit `b784265` is recorded as bootstrap implementation. Not reverted —
re-landing identical, mutation-tested code purely to produce a tidier history would destroy real
evidence to buy an appearance of process. Remediation: `governance/plans/G1_REMEDIATION_PLAN.md`.

**The finding that matters most, because it invalidates a claim I made:** GPT-PM said remote CI was
red. It was, and the cause is not the code. Run `34513131209` (job `102991918020`) completed in
**4 seconds having executed zero steps**, with GitHub's annotation: _"The job was not started
because recent account payments have failed or your spending limit needs to be increased."_ So
"local `npm run verify` is green" was true and simultaneously worthless as gate evidence — every
"CI enforces X" statement in this repo is currently false, because nothing runs. Recorded as R11.
Verified independently via the GitHub API, not taken on GPT-PM's word.

**Two more verified-not-assumed facts:** `/branches/main/protection` returns 404, so `CODEOWNERS`
is presently decoration (R12) — and branch protection on a _private_ repo needs a paid GitHub plan,
which is why repo visibility is now an operator decision rather than a detail. GitHub also forbids
a PR author approving their own PR, so if Claude pushes as `xLZDx` the required-review model
deadlocks against itself (R13).

**Where I corrected GPT-PM rather than accepting its citation:** its approval was anchored to
`G0_PLAN.md` blob `b930873f…` _and_ to commit `71ab1cf`, while stating that `b784265` was excluded.
Those anchors contradict: `b930873f…` is the blob as of `b784265`; at `71ab1cf` it is `f69c7f7a…`.
Checked with `git rev-parse`. The difference is one prettier-padded markdown table separator — zero
semantic change — so the approval stands on its prose, but the citation is wrong and is recorded as
wrong rather than silently adopted. Lesson: request a hash-bound approval only against a frozen
artifact; asking while commits still land on the branch produces exactly this ambiguity.

**Decision 1 (branching), ruled by GPT-PM:** move to gate branches + PR. `gate/g1-remediation` is
explicitly authorized; each later `gate/gN-*` still needs its own gate-level GO. Direct commits to
`main` stop after this G0-closure commit. Under global CLAUDE.md §20 a genuine GPT-PM APPROVE is
sufficient authorization for branch creation, which is what this is.

**How to apply:** Do not start G2. Do not describe any CI check as enforcing anything until R11 is
resolved and a check has been observed actually failing on purpose (the negative controls in the
remediation plan).

---

## 2026-09-10 — G1: toolchain, CI, governance enforcement, first contracts

**Decision:** Established the TypeScript/npm-workspaces toolchain (prettier, eslint, tsc strict,
vitest), the CI workflows (`ci.yml`, `policy-integrity.yml`, `gate-scope.yml`), `.github/CODEOWNERS`,
the verification scripts (`assert-tests-ran`, `check-test-deletion`, `check-secrets`,
`mutation-check`), and `packages/contracts` — the normalized event envelope, queue payload, push
payload and provenance wrapper.

**Why these specific guard choices, since they will look arbitrary later:**

- **`.strict()` on every contract schema.** Raw bodies are not part of the central contract
  (INV-12/INV-14). A permissive schema lets a connector attach `body`/`snippet` and have it reach
  D1, the queue and the logs while every reviewer reads the type and sees no such field.
- **Telegram routing hints may not be `ai_policy: ALLOW`, enforced at the ingest boundary.**
  Defence in depth behind ADR-005's type-level AI boundary, so lost provenance fails loudly at the
  edge rather than looking AI-eligible three layers downstream.
- **`idempotencyKey` is length-prefixed, not delimiter-joined.** Any single-character separator
  collides when a field can contain it — `("a b","c")` and `("a","b c")` both render as `"a b c"`,
  so two distinct events would share a key and one would be silently dropped as a duplicate
  (INV-08).
- **`assert-tests-ran.mjs` with a test-count floor.** A suite that runs zero tests reports success;
  everything else here is asserted by tests.

**Evidence:** `npm run verify` green (format, lint, `tsc --noEmit` strict, 37 tests).
`npm run verify:mutation` — **all 7 mutations killed**, including the two controls that prove the
Telegram guard is source-specific rather than a blanket rejection. Secret scanner verified by
positive control: a planted Telegram bot token in a tracked file made it exit 1; after removal,
exit 0 over 70 files.

**A bug this caught, worth recording because it argues for the harness:** removing `shell: true`
from `assert-tests-ran.mjs` to silence a Node deprecation warning silently broke it — on Windows
`execFileSync` refuses to spawn the `npx.cmd` shim without a shell (CVE-2024-27980 fix), so the
script's "did the suite pass" check began returning false unconditionally. It was caught only
because `mutation-check.mjs` reported `BASELINE FAILS` against a suite that was demonstrably green.
Both scripts now run vitest's own JS entry via `process.execPath`, resolved with `require.resolve`
so workspace hoisting cannot break the path.

**How to apply:** When a gate adds a guard, add a mutation for it to `scripts/verify/mutation-check.mjs`
and confirm it is killed — an anchor that stops matching is reported as a survivor, never skipped.
Raise `MIN_TESTS` as suites grow; never lower it to make a build green.

**Open, deliberately not resolved here:** a real secret scanner (gitleaks) is not wired in, because
pinning a third-party action to an unverified SHA in the pipeline that guards secrets is worse than
the gap; `npm audit` is advisory-only at G1. Both are recorded as debt rather than quietly assumed
done.

---

## 2026-09-10 — G0 evidence complete; three findings that change the design

**Decision:** G0's live-verification items (B Telegram, C Cloudflare, D Gmail) are done and
recorded in `docs/architecture/EXTERNAL_ASSUMPTIONS.md` with URLs, fetch dates, content hashes and
verbatim quotes. The CPU probe harness (item E) is written but **NOT RUN** — it needs an
operator-owned Cloudflare Free account. Gate-manifest integrity (item O) is designed in
`governance/GATE_MANIFEST_INTEGRITY.md`. ADR drafts F-M and the threat model N are written.

**Three findings that would have produced wrong code had we skipped this gate:**

1. **Cloudflare's Queue-consumer CPU documentation is now self-contradictory in three places**, and
   _no_ page publishes a Free-plan figure at all — the Workers limits CPU table has no
   Queue-consumer row, the Queues page says 30s/5min "applies to Free", and the pricing page puts
   "15 minutes" in the Paid column. The paid figure itself differs between pages (15 min vs 5 min).
   NB1 is therefore NOT resolved by documentation; the conservative 10ms assumption stands and the
   empirical probe is the answer of record. `RISK_REGISTER.md` R8 stays open.
2. **D1 Free allows only 50 queries per Worker invocation** (Paid: 1,000) — a second ceiling absent
   from TDD §65 entirely. The consumer is bound by CPU _and_ query count; fetching 20 topic
   candidates in a loop would hit the query ceiling before CPU ever mattered. New R10; binding on
   G2's design.
3. **Telegram's prohibition is broader than this project had recorded**: the Content Licensing
   terms forbid "scraping, **indexing**, **harvesting**, aggregation... train, fine-tune,
   **validate**... development, enhancement, **benchmarking** or deployment". A vector/embedding
   index over Telegram content is prohibited even with no training; using Telegram content as an
   evaluation set is prohibited. `core/SOURCE_POLICY.md` now quotes the real text.

**Also found:** `ADR-011`'s "pre-approved" HTTP-pull-consumer fallback has **no published
plan-eligibility statement** for Free (new R9 — an unverified fallback is not a fallback); Workers
AI free allocation is 10,000 Neurons/day (not in TDD §65); Analytics Engine 100K/10K per day is now
officially published, closing the v0.2 review's MIN-5 open item; and Google's _documented_ Gmail
404-recovery is a **full** sync — this project's bounded recovery is its own engineering decision
and must not be attributed to Google (`docs/architecture/TDD.md` §12.1 wording corrected in
`EXTERNAL_ASSUMPTIONS.md`).

**Evidence:** `docs/architecture/EXTERNAL_ASSUMPTIONS.md` — every claim carries the URL actually
fetched plus fetch date; Telegram documents pinned by SHA-256 of extracted text because neither
carries a version or `Last-Modified` header.

**How to apply:** G2 must design candidate selection as a single batched query and count queries
per invocation in the quota harness. Any future retrieval/embedding feature over Telegram content
is prohibited outright, not merely "not planned". The Gmail ingestion layer must keep push and
poll interchangeable behind one interface until the billing experiment (R3) returns.

---

## 2026-09-10 — GPT-PM conversation registered for this project

**Decision:** Registered `personal-decision-os` in PM Bridge, binding this repo and
`https://github.com/xLZDx/Personal_Decision_Command_Center.git` to ChatGPT conversation
`6aa27eb5-7048-83eb-a8a4-e901b86a0f80`.

**Why:** The TDD's governance model names GPT-PM as a final gate authority alongside the operator,
but no conversation mapping existed — flagged as an open item in `governance/plans/G0_PLAN.md`,
then resolved by the operator supplying the conversation link.

**How to apply:** Gate reviews and closure notifications for this project use
`project: "personal-decision-os"`.

---

## 2026-09-10 — `AGENTS.md` added as the tool-agnostic contract

**Decision:** Added a root `AGENTS.md` carrying the same authority boundary, invariants, DoD and
review-role pointers as `CLAUDE.md`, framed for any coding agent (Codex/ChatGPT, Aider, etc.).
`CLAUDE.md` now states the two must be kept in sync.

**Why:** Operator caught its absence ("а где agents.md?"). Verified: every other project in this
workspace (`ERP`, `Fitness_App`, `RQDO`, `TENDER`, `Ferma`, `AI_trading_assistance`, and 12 more)
carries a root `AGENTS.md` as the non-Claude-Code entry point, with `CLAUDE.md` as the
Claude-Code-specific one — the initial scaffold created only `.claude/agents/` (the ten review-role
subagents) and read the operator's "агентс" as meaning only that.

**Evidence:** `find D:\Repo -maxdepth 2 -iname AGENTS.md` returned 18 sibling projects;
`D:\Repo\ERP\AGENTS.md:1-5` states the convention explicitly ("Tool-agnostic conventions for any
coding agent... `CLAUDE.md` is the Claude Code entry point; this file is for everyone else").

**How to apply:** When either governance file changes, update both. A future gate that adds build/
test commands must add them to `AGENTS.md` too — that section currently says "no code exists yet".

---

## 2026-09-10 — Repository scaffold created; G0 started

**Decision:** Initialized the git repository at `D:\Repo\Personal_Decision_Command_Center` (empty
before this), created the full directory structure from TDD §55, adopted TDD v0.3 FINAL verbatim
into `docs/architecture/TDD.md`, and created the project-specific `CLAUDE.md`, `core/` governance
docs, ADR drafts, and `.claude/agents/` review-role definitions.

**Why:** Operator GO, scoped explicitly to repo-structure creation + G0 (not blanket MVP1
authorization) per `governance/reviews/00-claude-implementation-kickoff-v0.3.md`.

**Evidence:** `git log`, this commit's diff.

**Known defect carried over, not fixed by this decision:** the source documents in
`Personal_Decision_OS_v0.3_Implementation_Pack/` (and therefore `docs/architecture/TDD.md`'s ASCII
diagrams, and `governance/reviews/02-tdd-v0.2-adversarial-review.md`'s Cyrillic prose) contain
mojibake — UTF-8 bytes that were at some point decoded/re-encoded as a single-byte codepage before
being saved. Example: `docs/architecture/TDD.md` §0 pipeline diagram renders arrows as `â`/`â¼`
instead of Unicode arrows; `governance/reviews/02-tdd-v0.2-adversarial-review.md`'s date line reads
`**ÐÐ°ÑÐ°:** 2026-09-10` instead of `**Дата:**`. This was present in the files the operator supplied,
adopted byte-for-byte (not introduced by this scaffold), and is cosmetic only — it does not change
any invariant, ADR, or DoD text. Flagged here rather than silently fixed because the TDD is
described as "FINAL"/frozen; a content-preserving encoding cleanup is a candidate follow-up but
needs an explicit decision before touching the frozen baseline.

**How to apply:** G0 evidence work (live snapshots, ADR text, threat model) proceeds against the
TDD's semantic content; the diagram/prose mojibake is not blocking.

---

## Template for future entries

```
## YYYY-MM-DD — <short title>

**Decision:**
**Why:**
**Evidence:**
**How to apply:**
```
