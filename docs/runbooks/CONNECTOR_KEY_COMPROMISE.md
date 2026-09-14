# Runbook: Connector Key Compromise

**Status:** operational draft for G4 incident response.
**Trigger:** suspected leak of a connector HMAC/mTLS key, or of TDLib session material
(TDD §40, §41).

Immediate containment: stop the connector's delivery loop while preserving the encrypted spool;
do not delete evidence or copy session material. Revoke the Telegram session from an independent
trusted client, revoke the affected connector/tunnel signing identity, and mark its `key_id`
unusable. Rotate the ECDH/content-gateway key and any connector authentication key using
`CONTENT_GATEWAY_KEY_ROTATION.md`; do not reuse the compromised pair.

Rebuild or re-authenticate the host from a trusted image, restore only the normalized spool, and
verify `connected_at`/offline state before resuming delivery. Reconcile accepted event IDs against
central ingest; duplicates must remain idempotent. Record incident time, revoked key IDs, recovery
commit, and operator decision in `../../core/DECISION_LOG.md`—never session secrets or raw content.
