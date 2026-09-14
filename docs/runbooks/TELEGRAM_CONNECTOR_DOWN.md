# Runbook: Telegram Connector Down

**Status:** operational draft for the G4 connector slices.
**Trigger:** `connector_up=false` or `connector_last_event_age` past threshold (TDD §46, §48).

Expected recovery behavior (TDD §11, §62): reconnect after up to 6h outage must succeed without
re-emitting events older than `connected_at` and without losing local spool state.

1. Confirm the host process is running and inspect the connector health snapshot. Do not print
   TDLib session files, message bodies, or environment secrets.
2. Confirm `cloudflared` is connected outbound-only. If the tunnel is unavailable, keep TDLib
   receive and the local spool running; do not open an inbound port or public listener.
3. Inspect the SQLite spool in read-only mode. Record counts for `PENDING`, `FAILED_RETRYABLE`,
   and `FAILED_PERMANENT`; never copy the database to an unencrypted location.
4. Restart the connector process only after preserving the spool path. On `READY`, verify the
   new `connected_at` and drain the backlog through the normal authenticated ingest path.
5. If the spool is growing, classify the ingest/tunnel error before changing retry settings. A
   permanent failure requires operator review; it must not be silently discarded.
6. Escalate to `CONNECTOR_KEY_COMPROMISE.md` only when evidence suggests credential/session
   compromise rather than ordinary outage. Record timestamps, state transitions, and event IDs,
   never raw Telegram content.
