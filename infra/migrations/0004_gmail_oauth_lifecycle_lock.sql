-- Migration 0004: G3 checkpoint 4, round-8 full-sweep fix (GPT-PM round 8, 3 MAJOR).
--
-- Round 8's full adversarial sweep (requested explicitly, per the operator's instruction to stop
-- one-finding-per-round review) found that migration 0003's disconnect_lease_token/
-- disconnect_lease_expires_at columns on gmail_connections cannot fully close the underlying
-- invariant (never reopen OAuth access while an older, unconfirmed project-wide Google revoke
-- might still be live/propagating), for three reasons living on gmail_connections itself:
--
-- 1. connectGmailAccount() called googleClient.exchangeCode() BEFORE any exclusion check at all --
--    the only guard was the final INSERT ... ON CONFLICT DO UPDATE ... WHERE clause, which is
--    never evaluated on the plain INSERT path taken when the row does not currently exist (e.g.
--    because a concurrent disconnect already deleted it). A reconnect could therefore mint and
--    persist a fresh credential while an unrelated disconnect's revoke() was still genuinely in
--    flight, with the coordination state (the lease columns) gone the moment the row was deleted.
-- 2. A successful revokeToken() HTTP response was treated as proof Google's revocation had FULLY
--    taken effect; Google's own documentation says revocation can take additional time to
--    propagate after a successful response. Clearing the lease immediately on that response could
--    reopen reconnect during that propagation window.
-- 3. googleClient.stopWatch() (Gmail's `users.stop`) is itself a remote, mutating Google API call,
--    but a stopWatch() failure was treated as provably local/pre-Google -- releasing the lease
--    immediately on a transport failure whose actual delivery to Google was unknown, exactly the
--    same class of ambiguity already fixed for revokeToken() in round 7.
--
-- Fix: a coordination record that (a) survives deletion of gmail_connections entirely (a separate
-- table, per GPT-PM's own suggested shape: "a separate per-account lifecycle row/tombstone"),
-- (b) is acquired by BOTH connectGmailAccount and disconnectGmailAccount as a single mutually
-- exclusive lock -- at most one of {a connect attempt, a disconnect attempt} may hold it for a
-- given account at any time, closing finding 1 by making exchangeCode() run only while genuinely
-- holding exclusivity, not merely checking it once up front -- and (c) records revoke_settled_at
-- so a fresh connect's own lock acquisition can additionally require a conservative propagation
-- buffer to have elapsed since the last successful revoke, closing finding 2 (best-effort, since
-- no Google-documented SLA exists to derive an exact bound from -- see oauth.ts's own doc comment
-- for the honest limits of this mitigation).
--
-- gmail_connections.disconnect_lease_token/disconnect_lease_expires_at (migration 0003) are now
-- superseded and no longer written by either function -- left in place rather than dropped, since
-- SQLite/D1 column removal requires a full table rebuild this round does not need to also take on;
-- a future cleanup migration may remove them once this design is confirmed stable.
CREATE TABLE gmail_oauth_lifecycle (
  source_account_id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'gmail' CHECK (source = 'gmail'),
  lock_token TEXT,
  lock_kind TEXT CHECK (lock_kind IN ('CONNECT', 'DISCONNECT')),
  lock_acquired_at TEXT,
  revoke_settled_at TEXT,
  CHECK ((lock_token IS NULL) = (lock_kind IS NULL)),
  CHECK ((lock_token IS NULL) = (lock_acquired_at IS NULL)),
  -- No ON DELETE clause is deliberate, not an oversight (database-reviewer MINOR, round-8 internal
  -- review): this row must never disappear before this table's own row does (see the trigger
  -- below), so a restricting FK is the correct match for that invariant -- deleting the parent
  -- source_accounts row while a gmail_oauth_lifecycle row still references it will fail the FK
  -- check rather than silently orphaning or cascading. Any future "delete an account" feature must
  -- delete this table's row FIRST (after confirming lock_token IS NULL -- never delete a held
  -- lock's bookkeeping) as an explicit step, not rely on a cascade.
  FOREIGN KEY (source_account_id, source) REFERENCES source_accounts(source_account_id, source)
);

-- Round-8 internal review (architect, MAJOR): the "never delete this row" invariant this table's
-- entire design depends on (see the header comment above -- it is what lets the lock survive a
-- concurrent disconnect's DELETE of gmail_connections) was previously enforced ONLY in TypeScript
-- prose (oauth.ts's own doc comments), nowhere in the database. A future migration or an
-- out-of-module script deleting a row here would silently reopen exactly the round-8 finding-1 race
-- this table exists to close, with no test or constraint anywhere that would catch it. Enforced here
-- mechanically instead: any DELETE against this table is rejected outright, unconditionally --
-- there is currently no legitimate reason for this table's own row-count to ever shrink for an
-- account that source_accounts still knows about.
CREATE TRIGGER trg_gmail_oauth_lifecycle_no_delete
BEFORE DELETE ON gmail_oauth_lifecycle
BEGIN
  SELECT RAISE(ABORT, 'gmail_oauth_lifecycle rows must never be deleted -- see migration 0004''s own header comment for the invariant this protects');
END;
