-- Migration 0001: accounts/policy bootstrap + durable ingest/outbox/DLQ pipeline (G2).
--
-- Scope decision, stated plainly rather than left implicit: TDD.md §34 lists ~30 tables as "the
-- minimum D1 tables" across every future gate (people/identities -- G5; projects/streams/topics --
-- G5; intents/decisions/commitments/milestones/knowledge_items/deliverables -- G6;
-- notifications/snoozes -- G7; ai_runs/policy_decisions -- G6; audit_events/backup_runs/
-- retention_runs -- G8). This migration creates only the tables G2's own scope and DoD (TDD §71)
-- actually need: the account/policy/cursor tables ingest depends on, and the ingest/outbox/DLQ
-- pipeline itself. Each later gate adds its own migration for its own domain when that domain is
-- actually implemented -- inventing untested schema now for logic that does not exist yet is
-- exactly the "no half-finished implementation" this project's own discipline argues against, and
-- TDD §35's only concrete migration-numbering instruction ("indexes in migration 001") reads
-- naturally as "index the tables THIS migration creates," not "every table across every gate must
-- exist before any of them are built." Flagged here for GPT-PM/operator to correct if this reading
-- is wrong.
--
-- Column-level detail is not specified anywhere in TDD.md (confirmed absent); every column below
-- is derived directly from an existing, tested contract (packages/contracts/src/*.ts) or from a
-- binding rule in TDD §13/§14/§16/§16.3/§17/§18 -- see the comment above each table.
--
-- EDITED IN PLACE for the G2 architecture review's 3 rounds (governance/plans/
-- G2_PIPELINE_ARCHITECTURE_PROPOSAL_V3.md, GPT-PM APPROVE) plus the G2 implementation plan's own
-- 5 rounds (core/DECISION_LOG.md) -- never applied to any live D1 instance (confirmed during the
-- architecture round), so edited rather than superseded by a 0002 migration:
--   - devices table REMOVED: no G2-scope table references it, and it was speculative reservation
--     for G7 push targeting with no current consumer -- reintroduce it in the migration that
--     actually needs it.
--   - source_accounts/source_policies gain a UNIQUE(id, source) pair so ingest_events can hold a
--     genuine composite FK to (id, source), closing a real cross-source integrity gap: without it,
--     nothing prevented an ingest_events row from citing a source_account_id that belongs to a
--     DIFFERENT source than the event's own source column.
--   - source_policies gains a CHECK forbidding telegram+ALLOW (core/SOURCE_POLICY.md's binding
--     per-source default).
--   - ingest_events gains source_version (idempotency across edits/updates), processing_attempt_count
--     /processing_lease_owner/processing_lease_token/processing_lease_expires_at/first_failed_at
--     (fenced processing lease, ADR-006 addendum) with CHECKs binding lease-state to PROCESSING.
--   - processing_lease_token is the SOLE compare-and-swap fencing value (a fresh UUID per claim);
--     processing_lease_owner is retained for observability only, never for fencing -- closes an ABA
--     race where a stale claimant from the same worker identity could pass an owner-only fence.
--   - processing_outbox renamed attempt_count -> dispatch_count and gains a CLOSED terminal state.
--   - ingest_event_routing_hints gains sensitivity/created_at/derivation_version, matching the
--     ProvenanceValue<T> contract wrapper exactly instead of flattening it.
--   - NEW ingest_nonces / ingest_signing_keys: the generic HMAC ingest-authentication boundary
--     (TDD's authenticate + validate + dedupe -> D1 contract). ingest_signing_keys is METADATA ONLY
--     -- no secret key bytes are ever stored in D1; actual HMAC secret material lives in Cloudflare
--     Worker Secret bindings.

-- users: single-user MVP1, but a real table rather than an assumed singleton, since source_accounts
-- needs a stable owner reference.
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- source_accounts: one row per connected external account (a Gmail mailbox, a Telegram session).
-- UNIQUE(source_account_id, source) exists solely so ingest_events can hold a composite FK to
-- (source_account_id, source), which closes a real integrity gap: without it, nothing prevented an
-- ingest_events row from citing a source_account_id belonging to a DIFFERENT source than the
-- event's own source column.
CREATE TABLE source_accounts (
  source_account_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  source TEXT NOT NULL CHECK (source IN ('telegram', 'gmail')),
  account_label TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'REVOKED')) DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_account_id, source)
);
CREATE INDEX idx_source_accounts_user ON source_accounts(user_id);

-- source_policies: per-source AI/handling policy (core/SOURCE_POLICY.md). INV-22: unknown/mixed
-- source policy fails closed -- ingest_events.source_policy_id is NOT NULL with no default, so an
-- event with no resolvable policy cannot be inserted at all rather than defaulting to ALLOW.
-- The telegram+ALLOW CHECK enforces core/SOURCE_POLICY.md's binding per-source default at the
-- database level, not merely as an application-layer convention.
CREATE TABLE source_policies (
  source_policy_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('telegram', 'gmail')),
  ai_policy TEXT NOT NULL CHECK (ai_policy IN ('ALLOW', 'DENY')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (source_policy_id, source),
  CHECK (NOT (source = 'telegram' AND ai_policy = 'ALLOW'))
);

-- source_cursors: connector-side sync-position bookkeeping (Gmail historyId, Telegram last-seen
-- message id) -- an opaque cursor value, never source content.
CREATE TABLE source_cursors (
  source_account_id TEXT PRIMARY KEY REFERENCES source_accounts(source_account_id),
  cursor_value TEXT,
  updated_at TEXT NOT NULL
);

-- ingest_events: the durable record of every accepted NormalizedEvent (ADR-004). State machine
-- ACCEPTED -> PROCESSING -> PROCESSED, or -> RETRYABLE_FAILED -> DLQ (ADR-006, TDD §17).
--
-- content_locator_ref is the ONLY content-adjacent column, and it is a pointer (ContentLocator.ref
-- from ADR-004), never the content itself -- this table can be read end-to-end by any reviewer
-- without ever seeing a message body, matching INV-12.
--
-- source_version: mandatory (structurally, not by convention) for MESSAGE_UPDATED, and when
-- present must be non-empty AFTER TRIMMING (whitespace-only is rejected the same as empty) --
-- closes M4's idempotency gap, where two distinct malformed updates could otherwise collapse onto
-- the same revision identity.
--
-- processing_lease_token is the SOLE compare-and-swap fencing value for every mutation of a
-- PROCESSING row (both the live processor's own claim/heartbeat/complete path, and the cron
-- stale-lease-recovery sweep). processing_lease_owner is retained for observability only.
-- Stale-lease recovery's own mutation additionally conditions on processing_lease_expires_at at
-- mutation time (not just the token), because the heartbeat/renewal path extends
-- processing_lease_expires_at WITHOUT rotating the token -- a token-only fence would let a cron
-- sweep incorrectly fail a lease a live processor had just legitimately renewed.
CREATE TABLE ingest_events (
  event_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('telegram', 'gmail')),
  source_account_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_thread_id TEXT,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('MESSAGE_CREATED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED')),
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  content_locator_ref TEXT NOT NULL,
  source_policy_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  source_version TEXT,
  -- ADR-004: length-prefixed(source_account_id, source_event_id, event_type, source_version).
  -- The UNIQUE index below IS the idempotency guarantee (TDD §14) -- a duplicate submission's
  -- insert collides with the existing row instead of creating a second logical event.
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('ACCEPTED', 'PROCESSING', 'PROCESSED', 'RETRYABLE_FAILED', 'DLQ'))
    DEFAULT 'ACCEPTED',
  processing_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (processing_attempt_count >= 0),
  processing_lease_owner TEXT,
  processing_lease_token TEXT,
  processing_lease_expires_at TEXT,
  first_failed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_account_id, source) REFERENCES source_accounts(source_account_id, source),
  FOREIGN KEY (source_policy_id, source) REFERENCES source_policies(source_policy_id, source),
  CHECK (event_type <> 'MESSAGE_UPDATED' OR source_version IS NOT NULL),
  CHECK (source_version IS NULL OR length(trim(source_version)) > 0),
  CHECK ((state = 'PROCESSING') = (processing_lease_expires_at IS NOT NULL)),
  CHECK ((processing_lease_token IS NULL) = (processing_lease_expires_at IS NULL)),
  CHECK ((processing_lease_owner IS NULL) = (processing_lease_expires_at IS NULL)),
  CHECK (state <> 'DLQ' OR processing_attempt_count >= 1)
);
CREATE UNIQUE INDEX idx_ingest_events_idempotency ON ingest_events(idempotency_key);
CREATE INDEX idx_ingest_events_source_account ON ingest_events(source_account_id);
-- Backs both the live processor's claim query and the cron stale-lease-recovery sweep's own
-- "PROCESSING rows whose lease has expired" scan -- both filter on state='PROCESSING' first.
CREATE INDEX idx_ingest_events_processing_lease
  ON ingest_events(processing_lease_expires_at, event_id, processing_attempt_count)
  WHERE state = 'PROCESSING';
-- (database review, G2, Finding 4: an earlier idx_ingest_events_unprocessed index on
-- (received_at, event_id) was dropped here -- no query in this codebase reads received_at in a
-- WHERE/ORDER BY predicate, so it was pure write-amplification with no read benefit. Re-add it
-- alongside whatever query actually needs it, with its own EXPLAIN QUERY PLAN test.)

-- routing_hints (ProvenanceValue[], ADR-004) live in child tables so each hint's own ancestry is
-- independently queryable rather than flattened/lost into a JSON blob on the parent row.
-- sensitivity/created_at/derivation_version match the ProvenanceValue<T> contract wrapper exactly
-- (M5): sensitivity is a required, non-empty opaque string (no invented LOW/MEDIUM/HIGH vocabulary
-- -- GPT-PM explicitly rejected inventing one pending a later vocabulary decision).
CREATE TABLE ingest_event_routing_hints (
  event_id TEXT NOT NULL REFERENCES ingest_events(event_id),
  hint_index INTEGER NOT NULL,
  -- Security fix (G2 review, MAJOR): mirrors packages/contracts' own MAX_ROUTING_HINT_VALUE_LENGTH
  -- (512) at the storage boundary, so a future write path that bypasses the contract schema still
  -- cannot smuggle unbounded content into a field this project treats as metadata, not content.
  value TEXT NOT NULL CHECK (length(value) <= 512),
  derivation_method TEXT NOT NULL
    CHECK (derivation_method IN ('RULE', 'STATIC_CONFIG', 'PROVIDER_METADATA', 'AI_EXTRACTION')),
  ai_policy TEXT NOT NULL CHECK (ai_policy IN ('ALLOW', 'DENY')),
  sensitivity TEXT NOT NULL CHECK (length(trim(sensitivity)) > 0),
  created_at TEXT NOT NULL,
  derivation_version INTEGER NOT NULL CHECK (derivation_version > 0),
  PRIMARY KEY (event_id, hint_index)
);

CREATE TABLE ingest_event_routing_hint_provenance (
  event_id TEXT NOT NULL,
  hint_index INTEGER NOT NULL,
  provenance_event_id TEXT NOT NULL REFERENCES ingest_events(event_id),
  FOREIGN KEY (event_id, hint_index) REFERENCES ingest_event_routing_hints(event_id, hint_index),
  PRIMARY KEY (event_id, hint_index, provenance_event_id)
);
CREATE INDEX idx_routing_hint_provenance_hint
  ON ingest_event_routing_hint_provenance(event_id, hint_index);

-- processing_outbox: TDD §17. PENDING -> DISPATCHED, or -> RETRY_PENDING, or -> BUDGET_DEFERRED
-- (soft-budget guard, TDD §16.3 -- explicitly not a failure state), or -> CLOSED (terminal, set
-- alongside an event reaching PROCESSED or DLQ so the reconciler's due-query stops scanning it).
CREATE TABLE processing_outbox (
  event_id TEXT PRIMARY KEY REFERENCES ingest_events(event_id),
  state TEXT NOT NULL
    CHECK (state IN ('PENDING', 'DISPATCHED', 'RETRY_PENDING', 'BUDGET_DEFERRED', 'CLOSED'))
    DEFAULT 'PENDING',
  dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_count >= 0),
  next_attempt_at TEXT NOT NULL,
  dispatched_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (state <> 'DISPATCHED' OR dispatched_at IS NOT NULL)
);
-- The reconciler's whole query is next_attempt_at + state + dispatch_count, always excluding
-- CLOSED rows (ADR-006). This index makes that a single indexed lookup -- TDD §35's binding
-- "no growing-table full scan in hot path" and the <=50-D1-queries-per-invocation ceiling
-- (ADR-011, R10) both depend on this existing.
CREATE INDEX idx_processing_outbox_due
  ON processing_outbox(next_attempt_at, event_id, state, dispatch_count)
  WHERE state <> 'CLOSED';

-- processing_attempts: append-only audit trail of each dispatch attempt. Never PII/content --
-- error_class/error_code only, matching dead_letter_events' own content-free shape (TDD §18).
CREATE TABLE processing_attempts (
  attempt_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES ingest_events(event_id),
  attempt_number INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT CHECK (outcome IN ('SUCCESS', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE')),
  error_class TEXT,
  error_code TEXT,
  processor_version TEXT NOT NULL,
  trace_id TEXT NOT NULL
);
CREATE INDEX idx_processing_attempts_event ON processing_attempts(event_id);

-- dead_letter_events: TDD §18. Structured, content-free. "DLQ is operational evidence, not silent
-- storage" -- DLQ count > 0 is meant to be OPS-visible, which needs this table's existence, not a
-- log line. Written by exactly one shared atomic primitive (packages/domain), used by both the
-- live processor's own at-cap outcome and the cron stale-lease-recovery sweep's at-cap outcome, so
-- a replayed/concurrent recovery attempt against an already-terminal row can never create a second
-- record for the same event_id (event_id is this table's PRIMARY KEY).
CREATE TABLE dead_letter_events (
  event_id TEXT PRIMARY KEY REFERENCES ingest_events(event_id),
  error_class TEXT NOT NULL,
  error_code TEXT NOT NULL,
  processor_version TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  first_failed_at TEXT NOT NULL,
  last_failed_at TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- queue_budget_counters: the soft-budget guard itself (TDD §16.3,
-- MAX_DISPATCHED_QUEUE_MESSAGES_PER_DAY = 2500). One row per UTC day, created lazily by the
-- reservation's own atomic self-bootstrapping upsert (packages/domain) -- no manual reset needed
-- across a day boundary. The CHECK below is the absolute, non-configurable ceiling; the actual
-- EFFECTIVE cap enforced per-reservation is a runtime configuration value that may be set lower
-- than 2500 without a schema change, per the TDD's "configurable downward without review" rule.
CREATE TABLE queue_budget_counters (
  day TEXT PRIMARY KEY,
  dispatched_count INTEGER NOT NULL DEFAULT 0
    CHECK (dispatched_count >= 0 AND dispatched_count <= 2500)
);

-- ingest_nonces: replay defense for the generic HMAC ingest-authentication boundary (TDD's
-- "authenticate + validate + dedupe -> D1" contract). Reservation is an atomic
-- INSERT ... ON CONFLICT DO NOTHING against the UNIQUE constraint below; a 0-row insert means the
-- (connector, key version, nonce) triple was already seen and the request is rejected as a replay.
-- A row is eligible for cleanup once it falls outside the SAME accepted timestamp window the
-- signature check itself uses -- no window-bounded nonce is ever purged early.
CREATE TABLE ingest_nonces (
  connector_id TEXT NOT NULL,
  key_version TEXT NOT NULL,
  nonce TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, key_version, nonce)
);
CREATE INDEX idx_ingest_nonces_cleanup ON ingest_nonces(reserved_at);

-- ingest_signing_keys: METADATA ONLY for HMAC key-version rotation -- no secret key bytes are
-- ever stored here. Actual HMAC secret material lives in Cloudflare Worker Secret bindings and is
-- looked up by (connector_id, key_version) at verification time; this table only records which
-- (connector, key version) pairs are currently valid and for how long, so a signature presenting
-- an unknown or revoked key version is rejected before any secret lookup is attempted.
CREATE TABLE ingest_signing_keys (
  connector_id TEXT NOT NULL,
  key_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  PRIMARY KEY (connector_id, key_version)
);
