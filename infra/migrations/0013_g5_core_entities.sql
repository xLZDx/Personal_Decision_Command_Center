-- Migration 0013: durable G5 entity graph and reversible identity/topic history.
CREATE TABLE people (
  person_id TEXT PRIMARY KEY,
  display_label TEXT NOT NULL CHECK (length(trim(display_label)) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL UNIQUE CHECK (length(trim(namespace)) BETWEEN 1 AND 64),
  display_label TEXT NOT NULL CHECK (length(trim(display_label)) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE streams (
  stream_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  display_label TEXT NOT NULL CHECK (length(trim(display_label)) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, display_label),
  UNIQUE(project_id, stream_id)
);
CREATE TABLE topics (
  topic_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  stream_id TEXT,
  business_identifier TEXT CHECK (business_identifier IS NULL OR business_identifier GLOB '*::*'),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'SEPARATE', 'MERGED', 'ARCHIVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id, stream_id) REFERENCES streams(project_id, stream_id)
);
CREATE TABLE topic_events (
  topic_id TEXT NOT NULL REFERENCES topics(topic_id),
  event_id TEXT NOT NULL,
  attached_at TEXT NOT NULL,
  attached_by TEXT NOT NULL,
  PRIMARY KEY(topic_id, event_id)
);
CREATE TABLE source_identity_audit (
  audit_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('telegram', 'gmail')),
  source_identity TEXT NOT NULL,
  previous_person_id TEXT,
  next_person_id TEXT,
  previous_state TEXT,
  next_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (length(evidence_json) <= 8192),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_source_identity_audit_key ON source_identity_audit(source, source_identity, created_at);
