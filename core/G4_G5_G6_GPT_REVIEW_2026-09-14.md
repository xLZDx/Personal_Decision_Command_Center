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
