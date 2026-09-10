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

No manifest exists yet — G0 has no manifest of its own by design (it is the readiness gate that
produces the manifest mechanism for G1 onward).
