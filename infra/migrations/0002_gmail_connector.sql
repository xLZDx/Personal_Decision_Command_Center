-- Migration 0002: G3 Gmail connector (governance/plans/G3_GMAIL_CONNECTOR_PROPOSAL.md V6,
-- GPT-PM round 6 APPROVE). Adds only the tables G3's own approved design actually needs -- no
-- schema for a later gate's domain, matching migration 0001's own stated scoping discipline.
--
-- G3 reuses G2's existing source_accounts/source_policies/source_cursors/ingest_events tables
-- unchanged (verified against migration 0001 and services/ingest/src/handler.ts before designing
-- this gate -- see the architecture proposal's own "What changed" sections). Nothing here
-- duplicates or competes with those.

-- gmail_connections: one row per connected Gmail mailbox (source_account_id is the same identity
-- source_accounts already uses for this account -- no separate Gmail-specific account id).
-- Stores ONLY the encrypted OAuth refresh token; an access token is never persisted anywhere
-- (proposal §2.5/§2.8 -- exchanged in memory per drill-down/sync request, discarded after use).
-- watch_history_id/watch_expiration track the current Gmail users.watch() registration so the
-- daily renewal job knows when to re-arm it; collection_mode records whether this connection runs
-- PUSH (watch + Pub/Sub) or POLL (HARD_ZERO fallback when no GCP billing account is available,
-- proposal §1/§2.2).
-- `source` is redundant with the row's own identity (this table is Gmail-only) but exists so the
-- FK below can be the same composite (account_id, source) shape migration 0001 already uses for
-- ingest_events -- closing the same cross-source integrity gap that composite FK closes there
-- (database review, G3 checkpoint 1: a plain single-column FK to source_accounts(source_account_id)
-- would let an application bug reference a source='telegram' account with nothing at the DB level
-- to reject it).
CREATE TABLE gmail_connections (
  source_account_id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'gmail' CHECK (source = 'gmail'),
  gmail_email TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  kek_version TEXT NOT NULL,
  collection_mode TEXT NOT NULL CHECK (collection_mode IN ('PUSH', 'POLL')),
  watch_history_id TEXT,
  watch_expiration TEXT,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_account_id, source) REFERENCES source_accounts(source_account_id, source)
);

-- oauth_flows: short-lived PKCE state for the Authorization Code + PKCE exchange (proposal §2.5).
-- One-time, race-safe consumption is an application-level DELETE ... RETURNING against this PK,
-- not a DB-level guarantee this table itself enforces -- see packages/domain's oauth module.
CREATE TABLE oauth_flows (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- gmail_source_enrichments: the AI-extraction pipeline's durable, idempotent result (proposal
-- §2.4). event_id is the PRIMARY KEY and the sole idempotency boundary a retried processing
-- attempt checks in step 0 before ever calling the AI provider again. The write itself is fenced
-- by the CURRENT G2 processing lease at INSERT time (application-level
-- `WHERE EXISTS (SELECT 1 FROM ingest_events WHERE event_id = ? AND state = 'PROCESSING' AND
-- processing_lease_token = ?)`, packages/domain) -- a stale claimant's INSERT affects zero rows
-- rather than authoring the canonical result after losing its fence (GPT-PM round-3 BLOCKER).
-- status='NO_CONTENT_DELETED' is the explicit marker for a MESSAGE_DELETED event that completes
-- with zero Gmail API calls and zero AI invocation (proposal §2.3/§2.4) -- summary/extracted_json
-- are NULL in that case, never a placeholder value.
CREATE TABLE gmail_source_enrichments (
  event_id TEXT PRIMARY KEY REFERENCES ingest_events(event_id),
  status TEXT NOT NULL CHECK (status IN ('COMPLETE', 'NO_CONTENT_DELETED')),
  summary TEXT,
  extracted_json TEXT,
  model_id TEXT,
  created_at TEXT NOT NULL,
  CHECK ((status = 'NO_CONTENT_DELETED') = (summary IS NULL AND extracted_json IS NULL AND model_id IS NULL))
);

-- gmail_push_deliveries: Pub/Sub push replay suppression as a REAL fenced lease -- token, CAS
-- reclaim, heartbeat -- not a one-way permanent-reject nonce (proposal §2.6, GPT-PM rounds 2-6).
-- lease_token is a fresh crypto.randomUUID() per claim/reclaim, the SOLE compare-and-swap fencing
-- value alongside a fresh lease_expires_at re-check AND the row's current state, all three
-- together at every mutation (mirrors ingest_events.processing_lease_token's own documented
-- discipline in migration 0001, and packages/domain/src/transitions.ts's real fence shape --
-- GPT-PM round 5 MAJOR: a token+expiry-only fence still missed a SELECT->completion->reclaim
-- race). gmail_account_id/start_history_id let the independent scheduled recovery sweep resume a
-- stuck delivery with no HTTP request still in flight and no dependency on a future Pub/Sub
-- redelivery (GPT-PM round 3 BLOCKER).
CREATE TABLE gmail_push_deliveries (
  message_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
  lease_token TEXT NOT NULL,
  leased_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  gmail_account_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'gmail' CHECK (source = 'gmail'),
  start_history_id TEXT NOT NULL,
  completed_at TEXT,
  CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL)),
  FOREIGN KEY (gmail_account_id, source) REFERENCES source_accounts(source_account_id, source)
);
-- Partial index, matching idx_ingest_events_processing_lease's real shape (migration 0001): the
-- recovery sweep's own WHERE state = 'IN_PROGRESS' AND lease_expires_at <= ? query must never scan
-- retained COMPLETED rows to find the handful of genuinely active expired ones (GPT-PM round 5
-- MAJOR -- a non-partial index sharing only the column order does not close this).
CREATE INDEX idx_gmail_push_deliveries_lease
  ON gmail_push_deliveries(lease_expires_at, message_id)
  WHERE state = 'IN_PROGRESS';

-- gmail_rate_reservations: Gmail's own 6,000-units/min-per-user quota (EXTERNAL_ASSUMPTIONS.md §D,
-- confirmed live in G0), enforced as a D1-shared atomic reservation rather than an in-memory
-- token bucket (GPT-PM round 3 MAJOR -- Cloudflare Worker isolates do not share memory and are not
-- guaranteed request affinity, so a local-only limiter cannot hold under concurrency). Same
-- self-bootstrapping UPSERT-reservation shape as packages/domain/src/budget.ts's own
-- queue_budget_counters, applied to a rolling 60-second window keyed by epoch-minute instead of a
-- calendar day.
CREATE TABLE gmail_rate_reservations (
  gmail_account_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'gmail' CHECK (source = 'gmail'),
  window_start_epoch_minute INTEGER NOT NULL,
  units_reserved INTEGER NOT NULL DEFAULT 0 CHECK (units_reserved >= 0 AND units_reserved <= 6000),
  PRIMARY KEY (gmail_account_id, window_start_epoch_minute),
  FOREIGN KEY (gmail_account_id, source) REFERENCES source_accounts(source_account_id, source)
);

-- gmail_ai_neuron_budget: Workers AI's own 10,000-Neurons/day free allocation
-- (EXTERNAL_ASSUMPTIONS.md §C, ADR-010 HARD_ZERO) -- a SEPARATE resource from gmail_rate_reservations
-- above (a Workers AI call consumes Neurons, not a Gmail API unit; GPT-PM round 4 MAJOR). Reserved
-- in a conservative, deterministic per-call Neuron estimate BEFORE each AIProvider call (G3
-- checkpoint-1 task: establish that estimate for the selected model), never after -- a reservation
-- that cannot be granted fails closed to the NoAIProvider degrade path rather than calling the
-- provider un-reserved (GPT-PM round 5 MAJOR).
CREATE TABLE gmail_ai_neuron_budget (
  day TEXT PRIMARY KEY,
  neurons_reserved INTEGER NOT NULL DEFAULT 0
    CHECK (neurons_reserved >= 0 AND neurons_reserved <= 10000)
);

-- gmail_api_budget_counters: Gmail API unit consumption against the platform's 80,000,000-units/day
-- project ceiling (EXTERNAL_ASSUMPTIONS.md §D) -- distinct from queue_budget_counters (G2's
-- Queue-dispatch budget, untouched by any Gmail-specific operation) and distinct from
-- gmail_rate_reservations above (that is the SHORT-WINDOW per-user ceiling; this is the daily
-- project-wide one). Same self-bootstrapping UPSERT shape as queue_budget_counters.
CREATE TABLE gmail_api_budget_counters (
  day TEXT PRIMARY KEY,
  units_consumed INTEGER NOT NULL DEFAULT 0 CHECK (units_consumed >= 0)
);
