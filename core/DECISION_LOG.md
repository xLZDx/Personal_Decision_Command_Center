# Decision Log

Durable decisions and evidence future gates need. Not for routine narration (global CLAUDE.md §8).
Newest entries at the top.

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
