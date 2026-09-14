# GPT Reviewer Consensus — G4/G5/G6 implementation slice

**Reviewed head:** `0612b2a`  
**Scope:** all G4–G6 implementation commits after `ca61b86`  
**Reviewers:** ARCH-01, SEC/PRIV, QA  
**Status:** **REJECT for formal G4–G6 closure; NEEDS REVISION for implementation continuation**

This is an independent GPT reviewer consensus over the exact local head. It is not an operator
gate approval and does not claim that G4, G5, or G6 is formally closed.

## Confirmed blockers

- The repository contains seams and pure primitives, not the production TDLib login/session
  persistence path, D1-backed resolver, persistent topic/identity state, or transactional merge/
  split audit required by the G4–G6 DoD.
- G5 has no durable manual merge/split operations, versioned audit identity, rollback/idempotency
  evidence, false-merge metric, or calibration/shadow dataset.

## Confirmed major risks

- `resolveTopicDeterministically` remains a public bypass of the runtime assignment boundary;
  namespace and provenance/trusted-confirmation checks are not common to every resolver entry.
- `TopicCandidate` treats caller-provided project/stream/participant/identifier fields as trusted;
  explicit merge is a plain boolean rather than an operator action with evidence.
- Telegram intent/parser composition needs a common bounded input and runtime event/timestamp
  validation before any regex pass. The parser does not yet extract the normative `ERP::Gate-4.2`
  identifier form.
- The ECDH helper now binds/verifies `keyId` and requires a replay guard, but key generation remains
  extractable and the helper is not connected to the full Access/service-token/source-authorization
  chain or a durable cross-restart nonce store.
- The spool has atomic lease/CAS fencing, but no lease renewal/heartbeat for deliveries longer than
  the 30-second lease; migration error handling and WAL checkpoint policy need hardening.
- The adapter/session boundary still needs production TDLib implementation, runtime normalized-event
  parsing, bounded backpressure, and session protection evidence.

## Resolved in remediation

- Differing project IDs hard-stop before explicit merge.
- Rejected identities return `personId: null`; runtime identity/source/event validation exists.
- Assignment rejects raw-content fields and naked business identifiers.
- Parser input is bounded; crypto `keyId` is AAD-bound; replay guard is mandatory.
- Spool claims use lease tokens and ACK/FAIL are CAS-fenced; adapter failures use a controlled sink.
- Full verification at reviewed head: 50 test files, 572 tests, typecheck/lint/secrets/audit green,
  zero audit vulnerabilities.

## Missing tests / next work

Actual `ERP::Gate-4.2` extraction, direct-resolver bypass rejection, trusted/untrusted assignment
states, threshold boundaries, invalid provenance timestamps, long-delivery lease renewal,
pre-lease migration failure, durable replay across restart, D1 identity/topic integration, manual
merge/split rollback, and full ADR-007 authentication-chain evidence.

## Recommendation

Continue implementation against the confirmed risks. Do not represent this slice as formal gate
closure or production-ready Telegram drill-down until the runtime/persistence and security-chain
items above have fresh evidence.

## Final follow-up review — HEAD `7139a7b` (adapter shutdown test commit `ccee733`)

Three independent GPT reviewers re-checked the remediation. Local implementation is materially
stronger and the targeted suite, typecheck, and lint pass, but consensus remains **NEEDS_REVISION /
REJECT for formal G4–G6 closure**.

Resolved in the follow-up: D1 resolver metadata tables and idempotent store are present; Telegram
lease renewal and stale-ACK fencing are covered; session READY boundaries are stable; the TDLib
adapter now has an epoch fence so queued updates do not cross `stop()`; host session validates
`NormalizedEventSchema` at its runtime seam.

Remaining blockers/majors: TDLib burst overflow still drops updates instead of providing durable
backpressure/recovery; production TDLib login/session and long-lived drain wiring are absent; G5
still lacks full people/projects/streams/topics runtime and transactional merge/split state
transitions; identity persistence is an overwrite without append-only history; confirmation flags
and audit evidence are caller-provided rather than cryptographically/trusted operator-bound; the
replay guard is process-local and the complete ADR-007 Access→Worker→Tunnel→Gateway chain is not
implemented. A lease renewal failure can still permit duplicate delivery unless the central ingest
idempotency contract is exercised end-to-end.

**Evidence:** reviewer outputs from `g5_arch_review`, `g5_sec_review`, `g5_qa_review`; exact current
branch `gate/g3-implementation` at `ccee733`.

## Follow-up consensus — HEAD `3ac1fb3`

The permanent code, silent-bugs, Python and design reviewer roles remain registered in
`core/REVIEW_PROTOCOL.md`. Independent architecture/security/QA follow-up confirmed the local
remediations: session eligibility filters overflow cache events, G5 split updates assignments,
G6 decision audit/state guards are present, and migration `0015_g6_integrity_triggers.sql` adds
referential and append-only protections. Local verification is 57 files / 596 tests, typecheck,
lint, secret scan and dependency audit green.

Consensus remains **NEEDS_REVISION / REJECT for formal G4–G10 closure** because production TDLib
login/source-cursor recovery, confirmed durable overflow delivery, full Access→Worker→Tunnel→Gateway
deployment, commitment/milestone persistence, PWA/Web Push, real-account/device/restore evidence,
G9 corpus metrics, and operator-approved governance manifests are external requirements. Reviewers
also retain concurrency-hardening and authoritative provenance as follow-up risks; they are not
silently downgraded by the green local suite.
