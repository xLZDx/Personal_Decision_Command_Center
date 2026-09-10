# Runbook: Gmail Gap Recovery

**Status:** placeholder — to be written with real steps at G3 (Gmail connector gate).
**Trigger:** `history.list` returns an expired/invalid (404) history cursor, or `watch` is close
to `watch_expiration` (TDD §12, §12.1, §48).

Bounded recovery begins no earlier than `connected_at`/last confirmed synchronized time —
`PRE_CONNECTION_BACKFILL=OFF` is never violated to "fix" a gap. Steps to be added once
`connectors/gmail` exists: verify `watch` renewal cadence, use `messages.list`/`messages.get` for
the known gap window only, rely on central idempotency for dedupe, confirm no message older than
the activation boundary was imported.
