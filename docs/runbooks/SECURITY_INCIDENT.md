# Runbook: Security Incident

**Status:** placeholder — to be written with real steps starting at G1 (governance/CI gate), kept
current thereafter.
**Scope:** any threat from `../architecture/THREAT_MODEL.md`'s catalogue that actually fires.

General shape until gate-specific detail exists: contain (revoke/rotate the specific credential
or session involved), assess (what provenance-tainted or raw content, if any, was exposed — check
against `../../core/SOURCE_POLICY.md` and `../../core/DATA_RETENTION_POLICY.md`), record in
`../../core/DECISION_LOG.md`, and — per global CLAUDE.md §4 — treat any actual secret exposure or
credential rotation as needing operator-level confirmation, not an autonomous implementer
decision.
