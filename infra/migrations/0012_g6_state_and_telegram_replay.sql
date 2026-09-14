-- Migration 0012: durable G6 state and cross-restart Telegram replay nonce reservation.
CREATE TABLE telegram_content_nonces (
  nonce TEXT PRIMARY KEY CHECK (length(nonce) BETWEEN 1 AND 256),
  expires_at TEXT NOT NULL,
  accepted_at TEXT NOT NULL
);
CREATE INDEX idx_telegram_content_nonces_expiry ON telegram_content_nonces(expires_at);

CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'NEEDS_REVIEW', 'SNOOZED', 'RESOLVED', 'CANCELLED')),
  owner TEXT NOT NULL,
  recommendation TEXT,
  priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  evidence_json TEXT NOT NULL CHECK (length(evidence_json) <= 8192),
  ai_policy TEXT NOT NULL CHECK (ai_policy IN ('ALLOW', 'DENY')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE commitments (
  commitment_id TEXT PRIMARY KEY,
  decision_id TEXT REFERENCES decisions(decision_id),
  actor TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  action TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'IN_PROGRESS', 'DUE_SOON', 'OVERDUE', 'BLOCKED', 'DONE', 'CANCELLED')),
  due_at TEXT,
  evidence_json TEXT NOT NULL CHECK (length(evidence_json) <= 8192),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE milestones (
  milestone_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  title TEXT NOT NULL,
  owner TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PLANNED', 'IN_PROGRESS', 'BLOCKED', 'DONE')),
  planned_at TEXT,
  forecast_at TEXT,
  forecast_source TEXT CHECK (forecast_source IN ('MANUAL', 'RULE_DERIVED', 'GMAIL_AI_SUGGESTED')),
  evidence_json TEXT NOT NULL CHECK (length(evidence_json) <= 8192),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE decision_state_audit (
  audit_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('DECISION', 'COMMITMENT', 'MILESTONE')),
  entity_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (length(evidence_json) <= 8192),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_decision_state_audit_entity ON decision_state_audit(entity_type, entity_id, created_at);
