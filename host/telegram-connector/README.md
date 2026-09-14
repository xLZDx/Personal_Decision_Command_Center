# Telegram connector host

The host process runs a pinned TDLib JSON client (native binary/container supplied at deploy time),
`TelegramTdlibProcessClient`, `TelegramSession`, and the SQLite WAL spool. Configure the TDLib
command and persistent database path outside git. The connector delivers only normalized metadata
envelopes to `/ingest/telegram` using `createTelegramIngestDeliver`; it never logs message bodies,
login codes, or session database contents.

Operational requirements:

- keep the TDLib database on encrypted, permission-restricted persistent storage;
- provision `TELEGRAM_V1_HMAC_SECRET` in the host secret manager and rotate by key version;
- run `TelegramConnectorRuntime.start()` as a supervised long-lived service;
- use a durable `onOverflow` path and source-cursor implementation for the selected TDLib binding;
- execute Telegram login interactively on the host terminal, never through chat or CI logs.
