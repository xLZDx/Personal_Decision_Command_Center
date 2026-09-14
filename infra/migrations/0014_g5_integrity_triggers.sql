-- Migration 0014: integrity checks for resolver references on SQLite/D1 without table rebuilds.
CREATE TRIGGER topic_assignment_topic_exists
BEFORE INSERT ON topic_assignments
WHEN NOT EXISTS (SELECT 1 FROM topics WHERE topic_id = NEW.topic_id)
BEGIN SELECT RAISE(ABORT, 'topic assignment references unknown topic'); END;
CREATE TRIGGER topic_event_topic_exists
BEFORE INSERT ON topic_events
WHEN NOT EXISTS (SELECT 1 FROM topics WHERE topic_id = NEW.topic_id)
BEGIN SELECT RAISE(ABORT, 'topic event references unknown topic'); END;
CREATE TRIGGER source_identity_audit_state_valid
BEFORE INSERT ON source_identity_audit
WHEN NEW.next_state NOT IN ('CONFIRMED', 'SUGGESTED', 'REJECTED')
BEGIN SELECT RAISE(ABORT, 'invalid identity audit state'); END;

-- A source event has exactly one canonical topic edge. Manual mutations are
-- append-only metadata so rollback/investigation never loses operator intent.
CREATE UNIQUE INDEX idx_topic_events_event_unique ON topic_events(event_id);
CREATE TABLE topic_mutation_audit (
  audit_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('ATTACH', 'DETACH', 'MERGE', 'SPLIT')),
  topic_id TEXT,
  event_id TEXT,
  source_topic_id TEXT,
  target_topic_id TEXT,
  actor TEXT NOT NULL CHECK (length(trim(actor)) BETWEEN 1 AND 256),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1024),
  evidence_json TEXT NOT NULL CHECK (length(evidence_json) <= 8192),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_topic_mutation_audit_created ON topic_mutation_audit(created_at);

CREATE TRIGGER source_identity_audit_no_update BEFORE UPDATE ON source_identity_audit
BEGIN SELECT RAISE(ABORT, 'source identity audit is append-only'); END;
CREATE TRIGGER source_identity_audit_no_delete BEFORE DELETE ON source_identity_audit
BEGIN SELECT RAISE(ABORT, 'source identity audit is append-only'); END;
CREATE TRIGGER topic_assignment_audit_no_update BEFORE UPDATE ON topic_assignment_audit
BEGIN SELECT RAISE(ABORT, 'topic assignment audit is append-only'); END;
CREATE TRIGGER topic_assignment_audit_no_delete BEFORE DELETE ON topic_assignment_audit
BEGIN SELECT RAISE(ABORT, 'topic assignment audit is append-only'); END;
CREATE TRIGGER topic_mutation_audit_no_update BEFORE UPDATE ON topic_mutation_audit
BEGIN SELECT RAISE(ABORT, 'topic mutation audit is append-only'); END;
CREATE TRIGGER topic_mutation_audit_no_delete BEFORE DELETE ON topic_mutation_audit
BEGIN SELECT RAISE(ABORT, 'topic mutation audit is append-only'); END;

CREATE TRIGGER source_identity_person_exists BEFORE INSERT ON source_identities
WHEN NEW.person_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM people WHERE person_id = NEW.person_id)
BEGIN SELECT RAISE(ABORT, 'source identity references unknown person'); END;
CREATE TRIGGER source_identity_person_exists_update BEFORE UPDATE OF person_id ON source_identities
WHEN NEW.person_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM people WHERE person_id = NEW.person_id)
BEGIN SELECT RAISE(ABORT, 'source identity references unknown person'); END;
