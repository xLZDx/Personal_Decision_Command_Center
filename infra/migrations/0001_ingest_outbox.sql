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

-- users: single-user MVP1, but a real table rather than an assumed singleton, since devices and
-- source_accounts both need a stable owner reference.
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- devices: registered client devices (PWA installs, G7 push targeting). Created now because
-- audit_events-adjacent tracking of "which device" is cheap to reserve and costly to retrofit.
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  device_label TEXT,
  push_subscription_ref TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX idx_devices_user ON devices(user_id);

-- source_accounts: one row per connected external account (a Gmail mailbox, a Telegram session).
CREATE TABLE source_accounts (
  source_account_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  source TEXT NOT NULL CHECK (source IN ('telegram', 'gmail')),
  account_label TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'REVOKED')) DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_source_accounts_user ON source_accounts(user_id);

-- source_policies: per-source AI/handling policy (core/SOURCE_POLICY.md). INV-22: unknown/mixed
-- source policy fails closed -- ingest_events.source_policy_id is NOT NULL with no default, so an
-- event with no resolvable policy cannot be inserted at all rather than defaulting to ALLOW.
CREATE TABLE source_policies (
  source_policy_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('telegram', 'gmail')),
  ai_policy TEXT NOT NULL CHECK (ai_policy IN ('ALLOW', 'DENY')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
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
CREATE TABLE ingest_events (
  event_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('telegram', 'gmail')),
  source_account_id TEXT NOT NULL REFERENCES source_accounts(source_account_id),
  source_event_id TEXT NOT NULL,
  source_thread_id TEXT,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('MESSAGE_CREATED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED')),
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  content_locator_ref TEXT NOT NULL,
  source_policy_id TEXT NOT NULL REFERENCES source_policies(source_policy_id),
  trace_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  -- ADR-004: length-prefixed(source_account_id, source_event_id, event_type). The UNIQUE index
  -- below IS the idempotency guarantee (TDD §14) -- a duplicate submission's insert collides with
  -- the existing row instead of creating a second logical event.
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('ACCEPTED', 'PROCESSING', 'PROCESSED', 'RETRYABLE_FAILED', 'DLQ'))
    DEFAULT 'ACCEPTED',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_ingest_events_idempotency ON ingest_events(idempotency_key);
CREATE INDEX idx_ingest_events_source_account ON ingest_events(source_account_id);

-- routing_hints (ProvenanceValue[], ADR-004) live in child tables so each hint's own ancestry is
-- independently queryable rather than flattened/lost into a JSON blob on the parent row.
CREATE TABLE ingest_event_routing_hints (
  event_id TEXT NOT NULL REFERENCES ingest_events(event_id),
  hint_index INTEGER NOT NULL,
  value TEXT NOT NULL,
  derivation_method TEXT NOT NULL
    CHECK (derivation_method IN ('RULE', 'STATIC_CONFIG', 'PROVIDER_METADATA', 'AI_EXTRACTION')),
  ai_policy TEXT NOT NULL CHECK (ai_policy IN ('ALLOW', 'DENY')),
  PRIMARY KEY (event_id, hint_index)
);

CREATE TABLE ingest_event_routing_hint_provenance (
  event_id TEXT NOT NULL,
  hint_index INTEGER NOT NULL,
  provenance_event_id TEXT NOT NULL,
  FOREIGN KEY (event_id, hint_index) REFERENCES ingest_event_routing_hints(event_id, hint_index)
);
CREATE INDEX idx_routing_hint_provenance_hint
  ON ingest_event_routing_hint_provenance(event_id, hint_index);

-- processing_outbox: TDD §17. PENDING -> DISPATCHED, or -> RETRY_PENDING, or -> BUDGET_DEFERRED
-- (soft-budget guard, TDD §16.3 -- explicitly not a failure state).
CREATE TABLE processing_outbox (
  event_id TEXT PRIMARY KEY REFERENCES ingest_events(event_id),
  state TEXT NOT NULL
    CHECK (state IN ('PENDING', 'DISPATCHED', 'RETRY_PENDING', 'BUDGET_DEFERRED'))
    DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  dispatched_at TEXT,
  updated_at TEXT NOT NULL
);
-- The reconciler's whole query is state + next_attempt_at + attempt_count (ADR-006). This index
-- makes that a single indexed lookup -- TDD §35's binding "no growing-table full scan in hot path"
-- and the ≤50-D1-queries-per-invocation ceiling (ADR-011, R10) both depend on this existing.
CREATE INDEX idx_processing_outbox_reconciler ON processing_outbox(state, next_attempt_at);

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
-- log line.
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
-- MAX_DISPATCHED_QUEUE_MESSAGES_PER_DAY = 2500). One row per UTC day; the outbox dispatcher checks
-- and increments this before dispatching, pausing (processing_outbox.state = 'BUDGET_DEFERRED')
-- once the daily guardrail is reached, and resuming on the next day's row.
CREATE TABLE queue_budget_counters (
  day TEXT PRIMARY KEY,
  dispatched_count INTEGER NOT NULL DEFAULT 0
);
