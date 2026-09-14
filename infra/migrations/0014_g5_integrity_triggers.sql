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
