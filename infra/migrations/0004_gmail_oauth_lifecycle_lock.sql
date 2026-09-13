-- Migration 0004: G3 checkpoint 4 -- gmail_oauth_lifecycle, a PROJECT-WIDE mutual-exclusion lock
-- shared by connectGmailAccount and disconnectGmailAccount for the whole Gmail OAuth surface.
--
-- History condensed (full per-round narrative in core/DECISION_LOG.md):
--
-- Round 8's full adversarial sweep found that migration 0003's disconnect_lease_token/
-- disconnect_lease_expires_at columns on gmail_connections could not close the underlying
-- invariant (never reopen OAuth access while an older, unconfirmed project-wide Google revoke
-- might still be live/propagating): connectGmailAccount called exchangeCode() before any exclusion
-- check; a successful revokeToken() response was treated as proof revocation had fully settled,
-- when Google's own documentation says propagation can continue afterward; stopWatch() failures
-- were treated as provably local/pre-Google, when it is itself a remote mutating call with the same
-- ambiguity already fixed for revokeToken() in round 7. Round 8's fix created this table, originally
-- keyed PER source_account_id.
--
-- Round 9's internal specialist review (architect, database-reviewer, functional-test-reviewer, run
-- BEFORE the round-9 GPT-PM review per this project's own CLAUDE.md SS17) found and fixed 5 further
-- defects in round 8's design (credential-write fencing, CONNECT-lock permanent-wedge, the never-
-- delete invariant's lack of DB enforcement, an unsafe reconciliation procedure, untested CAS
-- fencing) -- but kept the PER-source_account_id keying.
--
-- Round 10 (GPT-PM's round-9 full-sweep review, dispatched with an explicit instruction to check
-- the whole mechanism and its integrations, not just the round-9 remediations) found the per-
-- account keying itself was the wrong granularity, and it was the MOST SEVERE finding: verified
-- against Google's own primary documentation (developers.google.com/identity/protocols/oauth2/
-- native-app, "Token revocation" section, quoted in core/DECISION_LOG.md), Google's revoke
-- endpoint invalidates tokens "for all clients registered under that project" -- i.e. for the whole
-- app's access to that Google user, not scoped to whichever source_account_id happened to call
-- revoke. Two different source_account_id rows (nothing in source_accounts/gmail_connections
-- enforced uniqueness on the real Google identity) could independently acquire their OWN per-
-- account locks and never contend, so account A's disconnect/revoke and account B's connect could
-- interleave freely even though Google's revoke would invalidate BOTH at once. Migration 0005's
-- UNIQUE index on gmail_connections(LOWER(gmail_email)) (added in round 9) does not close this: it
-- only prevents two rows existing SIMULTANEOUSLY, but the actual race requires A's row to be
-- deleted (by A's own disconnect) before B's write lands, which the index cannot see.
--
-- THE FIX: this table is now a SINGLETON, matching Google's actual revocation grain. There is
-- exactly one row (source = 'gmail', the sole primary key value), seeded below and never deleted
-- (enforced by the trigger below, as before). EVERY connectGmailAccount and disconnectGmailAccount
-- call across EVERY account now contends on this ONE row -- at most one connect-or-disconnect
-- attempt, for ANY account, may be in flight at a time. This is the "conservative project-level
-- Gmail OAuth lifecycle lock for the whole exchange/revoke window" GPT-PM's round-9 review named as
-- the correct shape when the real Google identity cannot be known before the code exchange (it
-- can't -- exchangeCode() is the only way to learn `gmailEmail`, so nothing can key a per-identity
-- lock before that call happens). migration 0005's unique-email index remains as defense in depth
-- (documented in its own header, updated this round), never the synchronization primitive.
--
-- `source_account_id` is retained as a NULLABLE, purely DIAGNOSTIC column recording which account
-- currently holds the lock (NULL when free) -- no longer part of the primary key, and its foreign
-- key to source_accounts is nullable accordingly (SQLite does not enforce an FK check when a
-- referencing column is NULL, so this adds real integrity -- "if held, must reference a real
-- account" -- without requiring a value when free).
--
-- `recovery_state` is new this round (GPT-PM round-9 MAJOR): `listWedgedGmailDisconnectLocks`
-- previously inferred "wedged" purely from `lock_kind = 'DISCONNECT'`, which cannot distinguish a
-- genuinely stuck account (an ambiguous stopWatch/revokeToken failure) from a disconnect that is
-- simply, legitimately still executing. `recovery_state = 'EXTERNAL_OUTCOME_UNKNOWN'` is written
-- ONLY in disconnectGmailAccount's ambiguous-failure catch branch (see oauth.ts), so the safe
-- reconciliation listing can filter on it instead of guessing from `lock_kind` alone. A lock left
-- behind by a genuine process crash (which never reached its own catch block, so never wrote this
-- state) deliberately does NOT appear in that listing -- GPT-PM's own explicit guidance: that case
-- needs a separate, more heavyweight operator force-recovery procedure requiring independent
-- evidence the old invocation is actually dead, out of this checkpoint's scope, same deferral
-- already applied to the real fetch-backed GoogleOAuthClient and key-ring resolution (SS2.1).
CREATE TABLE gmail_oauth_lifecycle (
  source TEXT PRIMARY KEY CHECK (source = 'gmail'),
  source_account_id TEXT,
  lock_token TEXT,
  lock_kind TEXT CHECK (lock_kind IN ('CONNECT', 'DISCONNECT')),
  lock_acquired_at TEXT,
  revoke_settled_at TEXT,
  recovery_state TEXT CHECK (recovery_state IN ('EXTERNAL_OUTCOME_UNKNOWN')),
  CHECK ((lock_token IS NULL) = (lock_kind IS NULL)),
  CHECK ((lock_token IS NULL) = (lock_acquired_at IS NULL)),
  -- recovery_state only means something while a lock is actually held -- a released lock (or one
  -- that was never held) can never carry it forward.
  CHECK (recovery_state IS NULL OR lock_token IS NOT NULL),
  -- No ON DELETE clause is deliberate: this row must never disappear (see the trigger below), so a
  -- restricting FK is the correct match -- deleting a source_accounts row this lock currently
  -- references (source_account_id) will fail the FK check rather than silently orphaning. Only
  -- checked while source_account_id is non-NULL (lock held), by ordinary SQL FK semantics.
  FOREIGN KEY (source_account_id, source) REFERENCES source_accounts(source_account_id, source)
);

-- The single row this whole table's design depends on -- created once, here, never by application
-- code (connectGmailAccount/disconnectGmailAccount only ever UPDATE this row, never INSERT it,
-- since a singleton keyed by a CHECK-constrained literal PK cannot meaningfully be "created" more
-- than once).
INSERT INTO gmail_oauth_lifecycle (source, source_account_id, lock_token, lock_kind, lock_acquired_at, revoke_settled_at, recovery_state)
VALUES ('gmail', NULL, NULL, NULL, NULL, NULL, NULL);

-- The "never delete this row" invariant (this table's entire design depends on it existing exactly
-- once, always) is enforced mechanically, not only in TypeScript prose -- any DELETE against this
-- table is rejected outright, unconditionally.
CREATE TRIGGER trg_gmail_oauth_lifecycle_no_delete
BEFORE DELETE ON gmail_oauth_lifecycle
BEGIN
  SELECT RAISE(ABORT, 'gmail_oauth_lifecycle rows must never be deleted -- see migration 0004''s own header comment for the invariant this protects');
END;
