-- Migration 0011: durable G5 identity/topic state and append-only assignment audit.
-- Metadata only: no message bodies, display names, or model prompts are stored here.
CREATE TABLE source_identities (
  source TEXT NOT NULL CHECK (source IN ('telegram', 'gmail')),
  source_identity TEXT NOT NULL CHECK (length(trim(source_identity)) BETWEEN 1 AND 256),
  person_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('CONFIRMED', 'SUGGESTED', 'REJECTED')),
  evidence_json TEXT NOT NULL CHECK (length(evidence_json) <= 8192),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, source_identity),
  CHECK (state = 'REJECTED' OR person_id IS NOT NULL),
  CHECK (state = 'REJECTED' OR length(trim(person_id)) BETWEEN 1 AND 256)
);

CREATE TABLE topic_assignments (
  assignment_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  topic_id TEXT NOT NULL CHECK (length(trim(topic_id)) BETWEEN 1 AND 256),
  resolution TEXT NOT NULL CHECK (resolution IN ('AUTO_ATTACH', 'CANDIDATE_MERGE', 'SEPARATE', 'UNKNOWN')),
  score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  resolver_version TEXT NOT NULL CHECK (length(trim(resolver_version)) BETWEEN 1 AND 128),
  assigned_by TEXT NOT NULL CHECK (length(trim(assigned_by)) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_topic_assignments_topic ON topic_assignments(topic_id, updated_at);

CREATE TABLE topic_assignment_audit (
  audit_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('ASSIGN', 'MERGE', 'SPLIT', 'DETACH')),
  actor TEXT NOT NULL CHECK (length(trim(actor)) BETWEEN 1 AND 256),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1024),
  score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  resolver_version TEXT NOT NULL CHECK (length(trim(resolver_version)) BETWEEN 1 AND 128),
  evidence_json TEXT NOT NULL CHECK (length(evidence_json) <= 8192),
  created_at TEXT NOT NULL,
  FOREIGN KEY (assignment_id) REFERENCES topic_assignments(assignment_id)
);
CREATE INDEX idx_topic_assignment_audit_assignment ON topic_assignment_audit(assignment_id, created_at);
