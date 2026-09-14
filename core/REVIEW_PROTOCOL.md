# Permanent review protocol

Every gate slice is reviewed before the next gate starts. The implementer records the exact commit
under review and does not self-close governance findings.

## Required sequence

1. `gov-01` checks plan/scope/evidence before implementation review.
2. Relevant specialist roles run in parallel: `arch-01`, `data-01`, `sec-01`, `priv-01`, `rel-01`,
   `ai-01`, `qa-01`, `ux-01`, `code-01`, `silent-bugs-01`, `python-01`, and `design-01` as the
   changed surface requires.
3. A GPT reviewer consensus pass re-checks the exact commit and consolidates findings.
4. Findings are fixed or explicitly recorded as unresolved; severity cannot be downgraded by the
   implementer.
5. `red-01` runs only after every selected reviewer returns APPROVE.
6. Gate closure still requires operator-owned manifest/GO and GPT-PM/operator approval.

## Permanent reviewer responsibilities

- `code-01`: general correctness and contract review.
- `silent-bugs-01`: swallowed failures, dropped work, stale state and false-green tests.
- `python-01`: Python scripts/probes/CI safety; explicitly reports no-Python scope when applicable.
- `design-01`: end-to-end architecture, ownership, recovery, deployment and UX/API seams.

All reports use the global finding contract and include exact file/line evidence plus an acceptance
test. A green local suite is evidence, not approval.
