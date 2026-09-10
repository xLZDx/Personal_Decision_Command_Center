# Master Gate Plan

Source: `docs/architecture/TDD.md` §83. Each gate requires its own binding operator-approved
`governance/gate-manifests/<gate>.yaml` and its own plan-level GO (global CLAUDE.md §4 GO contract,
applied per-gate — see project `CLAUDE.md` §4). **Completion of one gate does not authorize the
next.**

| Gate | Scope | Status |
|---|---|---|
| G0 | Implementation-readiness verification + ADR freeze (adopt TDD v0.3, live platform/terms snapshots, empirical Cloudflare Free CPU probe, threat model, ADR-002/003/005/007/008/009/010/011, gate-manifest integrity mechanism) | **IN PROGRESS** — repo scaffold done, evidence package pending |
| G1 | Repository + governance enforcement + CI + contracts | NOT STARTED |
| G2 | D1 schema + provenance primitives + durable ingest/outbox + Queue/reconciler/DLQ + soft-budget guard + CPU/quota harness + live Analytics Engine limits snapshot | NOT STARTED |
| G3 | Gmail connector (OAuth, push/watch auth, renewal, bounded gap recovery, billing-account check + poll fallback, GmailEvidenceBundle + source-local AI extraction before merge) | NOT STARTED |
| G4 | Telegram direct TDLib connector (session, `connected_at` boundary, local spool, deterministic rules/provenance, offline/reconnect, Tunnel Content Gateway, ECDH/HKDF/AES-GCM drill-down) | NOT STARTED |
| G5 | Identity + Project + Stream + Topic resolver (namespaced identifiers, candidate/merge/split, cross-project hard barrier, no AI feedback from combined topic) | NOT STARTED |
| G6 | Intent + Decisions + Commitments + Minimal Milestones + Priority | NOT STARTED |
| G7 | PWA + Today + evidence drill-down + opaque Web Push (Android real-device, iPhone Home Screen real-device, standalone Access login/re-login) | NOT STARTED |
| G8 | Observability + reporting + retention + host-side backup + first restore | NOT STARTED |
| G9 | Shadow evaluation + calibration + adversarial end-to-end review | NOT STARTED |
| G10 | MVP1 closure | NOT STARTED |

## Gate workflow (per gate)

```
Recon -> Plan -> Plan review -> GO -> Implementation -> Test/verification ->
Implementer self-check -> Independent review(s) -> Remediation -> Re-verification ->
Final verdict -> Closure report -> Operator merge/push
```

No GO at the GO step ⇒ no implementation. No final approval ⇒ no gate closure (TDD §58).

## G0 required outputs (TDD kickoff prompt, `governance/reviews/00-claude-implementation-kickoff-v0.3.md`)

```
A. Adopt/freeze TDD v0.3 in repo.                                    DONE (docs/architecture/TDD.md)
B. Live Telegram API/Content Licensing terms snapshot.                PENDING
C. Live Cloudflare Workers/Queues/D1/Analytics/Tunnel/Workers-AI       PENDING
   assumptions snapshot.
D. Live Gmail watch/history assumptions snapshot.                     PENDING
E. Empirical Cloudflare Free CPU smoke harness + operator-run          PENDING
   instructions.
F. ADR-002 Gmail+Telegram MVP1 scope lock.                            DRAFT
G. ADR-003 direct TDLib.                                              DRAFT
H. ADR-005 provenance + assignment DAG, Gmail-only pre-aggregation    DRAFT
   AI boundary.
I. ADR-007 Tunnel Content Gateway, full auth chain, mandatory E2E     DRAFT
   envelope.
J. ADR-008 opaque push.                                               DRAFT
K. ADR-009 Gmail-only AI provider/data-use decision.                  DRAFT
L. ADR-010 HARD_ZERO cost mode.                                       DRAFT
M. ADR-011 Queue consumer runtime choice/fallback.                    DRAFT
N. Threat model update.                                               PENDING
O. Binding gate-manifest integrity mechanism design.                  PENDING
```

The empirical CPU probe (E) may require an operator-owned free Cloudflare account; if credentials
are unavailable to Claude, the probe script and exact reproducible instructions are still produced
— never fabricated results.

G0 closes with a `G0 PLAN REVIEW REQUEST` (format in the kickoff prompt) submitted for
independent review before G1 begins.
