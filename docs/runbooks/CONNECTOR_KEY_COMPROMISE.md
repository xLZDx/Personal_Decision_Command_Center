# Runbook: Connector Key Compromise

**Status:** placeholder — to be written with real steps at G4 (Telegram connector gate).
**Trigger:** suspected leak of a connector HMAC/mTLS key, or of TDLib session material
(TDD §40, §41).

Key rotation is mandatory infrastructure, not an incident-only capability: `active_key_id`,
`next_key_id`, grace overlap, revocation procedure must exist before this runbook is needed for
real. A connector-host compromise is treated as a source-account incident (see
`../architecture/THREAT_MODEL.md`) — revoke the Telegram session, rotate all connector keys,
re-authenticate the connector host, and record the incident in `../../core/DECISION_LOG.md`.
