# MVP1 real-device and real-account test runbook

This runbook is intentionally operator-executed. The coding environment cannot access a personal
Telegram account, Gmail account, Android handset, or iPhone, and must never receive passwords,
Telegram login codes, OAuth refresh tokens, or private keys in chat/logs.

## Preconditions

1. Deploy the current branch to an isolated staging project with D1 migrations through `0015` (including G5 integrity, unique event attachment, G6 referential and append-only audit triggers).
2. Provision secrets directly in the platform secret manager; record only secret version IDs.
3. Configure a test Telegram personal account and a test Gmail mailbox containing labeled,
   non-sensitive messages. Enable audit logging and a disposable notification subscription.
4. Install the staging PWA URL on one Android device and one target iPhone Home Screen.

The currently attached Android test handset is Samsung SM-G950F (Android 8.0).
Record only its serial and browser version in the operator manifest; never store
account credentials or login codes in this repository.

## Execution evidence

- Telegram: authorize TDLib, record `connected_at`, send one new message, reconnect after an
  induced offline interval, and confirm no pre-connection cache event reaches ingest. Burst-test
  updates above the adapter limit and verify the configured durable overflow callback drains every
  event exactly once by `event_id`.
- Gmail: complete OAuth/watch, deliver a labeled message, force a cursor gap, and verify bounded
  recovery plus idempotent ingest.
- Cross-source: use one safely labeled Telegram/Gmail pair to produce one topic/decision with two
  evidence references; inspect the AI request log and prove zero Telegram-derived fields.
- PWA: install/open on Android and iPhone Home Screen, authenticate in standalone mode, expire the
  session and re-login, receive an opaque `STATE_CHANGED` push, delete it, reopen the app, and
  verify sync-on-open repairs the missed state.
- Security: replay one captured content nonce after restart (must reject), verify expired content
  request rejection, inspect CSP/security headers, and confirm no body/title appears in queue,
  push, audit, or ordinary logs.
- Backup/restore: create encrypted host backup, restore into a fresh isolated D1, compare row
  counts/checksums, and attach the manifest plus restore transcript.

## Abort conditions

Stop immediately on any raw-content log, Telegram→AI request field, duplicate accepted event,
cross-project merge, lost overflow event, unencrypted backup, or device auth anomaly. Rotate the
affected test credentials and record the incident before retrying.

Attach redacted evidence (timestamps, IDs, hashes, counters, screenshots) to the G10 report; never
attach message bodies, OAuth tokens, login codes, or private keys.
