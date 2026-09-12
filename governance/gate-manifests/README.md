# Gate Manifests — Operator-Owned Protected Path

Per `docs/architecture/TDD.md` §57(5)-(9) and NM3's closure (`../../core/RISK_REGISTER.md`), a
binding `<gate>.yaml` manifest here (`plan_id`, `plan_hash`, `approved_scope`, `allowed_paths`,
`forbidden_paths`, `required_tests`, `required_reviewers`, `policy_sensitive_files`) must be
created or adopted by the operator/governance authority — **never authored solely by the
implementer**. A manifest an implementer could freely edit in their own branch has no authority,
which is exactly the self-referential integrity gap the v0.2 review flagged.

Claude may propose a next-gate manifest as a non-binding artifact (e.g. in `../plans/`), but it
becomes binding only once the operator adopts/commits the actual file here, and CI validates its
hash against operator-controlled protected state outside the implementer's writable branch (G0
item O designs that mechanism).

`g1.yaml` exists and is adopted (`GATE_MANIFEST_APPROVED_HASH_G1` set by the operator 2026-09-11,
matching this file's committed bytes). G0 never had a manifest of its own by design — it is the
readiness gate that produced this manifest mechanism for G1 onward, so there is nothing to author
until a gate exists to scope.

## Accepted file format

`scripts/verify/check-gate-scope.mjs` reads this file with a deliberately tiny YAML subset reader
rather than a YAML library, because a manifest is a governance document a human has to audit and
hash-approve. Anything it does not understand is a hard error, never a silently empty list — an
unreadable manifest must fail the gate, not quietly authorize everything.

```yaml
plan_id: pdos-g1-remediation-2026-09-10
plan_hash: <sha256 of the plan file>

allowed_paths:
  # one entry per line, block sequence only
  - packages/contracts/**
  - core/DECISION_LOG.md
  - '*.md'

forbidden_paths:
  - governance/gate-manifests/**
```

**Rules the reader enforces:**

- Block sequences only. `allowed_paths: [a, b]` (flow style) is rejected — a block reader would
  otherwise see an empty list and authorize nothing, or worse, be changed later to authorize
  everything.
- A key may appear only once. A duplicate is rejected rather than resolved, because the entry a
  human reads and the entry the check enforces could then differ.
- **Quote any pattern starting with `*`** (`- '*.md'`). Unquoted, YAML reads it as an alias, and
  the reader rejects it rather than guessing.
- Anchors, aliases, block scalars and nested mappings under these keys are rejected.
- Blank lines and `#` comments inside a list are fine; an inline `  # comment` after an unquoted
  value is stripped.
- **Every list entry must be indented.** An unindented `- pattern` is rejected. This is not
  pedantry: before the check was fixed, an entry that lost its indent silently ended the list, so
  a `forbidden_paths:` whose items were flush-left parsed as _no forbidden paths at all_ — with no
  error, while still reading correctly to a human reviewing the file for hash approval.
- A key that is **present but declares no entries** is an error. Omit the key entirely if you mean
  "none"; an empty list read from a key that is physically there is indistinguishable from a list
  the reader failed to read.
- `allowed_paths` missing or empty is an error, not a pass.

**Pattern matching is segment-bounded, unlike shell globbing:** `*` matches within one path
segment and never crosses `/`; `**` is a whole segment and matches any number of segments;
everything else, `.` included, is literal. So `packages/*` means files directly in `packages/`,
and `packages/**` means the whole subtree. A bare `**` matches everything and is reported as a
warning on every run — it makes the check unable to refuse anything.

Full rationale, and what this mechanism does NOT protect against, in
`../GATE_MANIFEST_INTEGRITY.md`.
