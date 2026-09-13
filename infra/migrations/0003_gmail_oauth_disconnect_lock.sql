-- Migration 0003: G3 checkpoint 4, round-3 fix. GPT-PM round-2/round-3 MAJOR, verified against
-- Google's own documentation (developers.google.com/identity/protocols/oauth2/native-app, "Key
-- Point" on token revocation): "Revocation removes all OAuth 2.0 scopes previously granted to a
-- project, invalidating any issued access or refresh tokens for ALL clients registered under that
-- project." Revocation is project-wide, not scoped to the single token passed to the endpoint --
-- so a reconnect that lands DURING an unrelated disconnect's revoke() call issues a credential
-- that the SAME revoke call then invalidates, even though checkpoint 4's round-1 CAS fix
-- correctly prevents the LOCAL D1 row from being destroyed. The local row surviving does not mean
-- the credential it holds survives.
--
-- Fix: a short-lived, fenced disconnect lease on gmail_connections itself (same single-row-lease
-- shape as ingest_events.processing_lease_token/processing_lease_expires_at, migration 0001) that
-- disconnectGmailAccount acquires BEFORE calling Google, and connectGmailAccount's own
-- ON CONFLICT ... DO UPDATE ... WHERE respects -- a reconnect landing while an active lease is
-- held is refused (DISCONNECT_IN_PROGRESS) rather than silently issuing a credential about to be
-- invalidated by the in-flight project-wide revoke.
ALTER TABLE gmail_connections ADD COLUMN disconnect_lease_token TEXT;
ALTER TABLE gmail_connections ADD COLUMN disconnect_lease_expires_at TEXT;
