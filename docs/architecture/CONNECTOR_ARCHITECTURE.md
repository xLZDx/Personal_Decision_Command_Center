# Connector Architecture

Canonical source: `docs/architecture/TDD.md` §9-12 (target architecture, deployment topology,
Telegram direct TDLib connector, Gmail connector), §15 (connector local spool). Binding decisions:
`../../core/adr/ADR-003-direct-tdlib.md`, `../../core/adr/ADR-007-cloudflare-tunnel-content-gateway.md`.

Index only, expanded into real implementation notes starting at G3 (Gmail) / G4 (Telegram).

## Connector-neutral event envelope (TDD §13)

All sources emit one normalized envelope (`event_id`, `source`, `source_account_id`,
`source_event_id`, `source_thread_id`, `event_type`, `direction`, `occurred_at`, `received_at`,
`content_locator`, `routing_hints[]` (each provenance-wrapped), `source_policy_id`, `trace_id`,
`schema_version`). Raw body is never part of this contract.

## Gmail (cloud control plane only, no connector host dependency)

`users.watch` -> Google Pub/Sub push -> authenticated Cloudflare endpoint -> `history.list`
incremental recovery. `PRE_CONNECTION_BACKFILL = OFF`, `POST_CONNECTION_GAP_RECOVERY = REQUIRED`
— these are separate concepts (TDD §12.1); recovery never silently imports messages older than
`connected_at`.

## Telegram (requires an always-on connector host — see `ADR-003`)

Direct TDLib. No historical bulk backfill on connection. Local SQLite WAL spool (`PENDING` /
`ACKED` / `FAILED_RETRYABLE` / `FAILED_PERMANENT`) holds outbound normalized events until central
ACK; transactional write before send, documented fsync/WAL checkpoint policy, exponential
backoff+jitter retry.
