# Runbook: Telegram Connector Down

**Status:** placeholder — to be written with real steps at G4 (Telegram connector gate).
**Trigger:** `connector_up=false` or `connector_last_event_age` past threshold (TDD §46, §48).

Expected recovery behavior (TDD §11, §62): reconnect after up to 6h outage must succeed without
re-emitting events older than `connected_at` and without losing local spool state. Steps to be
added once `connectors/telegram-tdlib` and `host/content-gateway` exist: check TDLib session
health, check connector-host reachability via Cloudflare Tunnel, check local spool for
`FAILED_RETRYABLE` backlog, escalate to `docs/runbooks/CONNECTOR_KEY_COMPROMISE.md` only if the
cause looks like session/credential compromise rather than ordinary outage.
