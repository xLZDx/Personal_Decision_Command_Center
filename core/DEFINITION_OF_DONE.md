# Definition of Done

Source: `docs/architecture/TDD.md` §67 (universal) and §68-82 (per-component: Telegram connector,
Gmail connector, Provenance/AI Policy, Queue/Reliability, Topic Resolver, Decision/State, Security,
PWA/Push, Observability, Backup/DR, MVP1 functional deliverables, quantitative evaluation,
performance targets, MVP1 exit).

## Universal DoD (a gate is DONE only if all applicable items are true)

1. Approved plan ID/hash exists.
2. Binding gate-manifest hash is operator-authorized and CI-verified.
3. Implementation scope exactly matches approved scope.
4. Changed paths comply with the gate manifest.
5. No unrelated source or feature entered the gate.
6. Code is committed on the approved branch.
7. Build passes.
8. Format/lint/typecheck pass.
9. Unit tests pass.
10. Contract/integration tests pass where applicable.
11. New behavior has tests.
12. Failure/recovery paths have tests.
13. Security implications reviewed.
14. Source policy implications reviewed.
15. Provenance/taint implications reviewed.
16. No source-derived content leaks to logs/metrics/push/fixtures.
17. Observability exists for new runtime behavior.
18. Documentation updated.
19. ADR updated/added when architecture or policy changed.
20. Required review agents completed evidence-backed review.
21. At least one substantive review is fresh-context independent from the implementer context.
22. Zero unresolved BLOCKER.
23. Zero unresolved MAJOR.
24. Accepted MINOR debt is explicit.
25. Exact verification commands/results recorded.
26. Rollback/recovery documented where applicable.
27. Applicable quota/CPU budget remains within HARD_ZERO constraints.
28. Policy-sensitive file integrity checks pass.
29. Gate-specific DoD is complete.
30. Closure report produced.
31. Final gate authority (GPT-PM + operator) returns APPROVE.

**A green test suite alone never closes a gate.** Per global CLAUDE.md §17: before citing a suite
as evidence, check the assertion would actually fail if the thing it guards were removed.

## Per-component DoD

See `docs/architecture/TDD.md`:

- §68 Telegram Connector DoD
- §69 Gmail Connector DoD
- §70 Provenance/AI Policy DoD
- §71 Queue/Reliability DoD
- §72 Topic Resolver DoD
- §73 Decision/State DoD
- §74 Security DoD
- §75 PWA/Push DoD
- §76 Observability DoD
- §77 Backup/DR DoD
- §78 MVP1 functional deliverables
- §80 MVP1 quantitative evaluation thresholds
- §81 MVP1 performance/reliability targets
- §82 MVP1 Exit Definition of Done (no partial closure)
