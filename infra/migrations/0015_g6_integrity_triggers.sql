-- Migration 0015: G6 referential and append-only audit guards.
CREATE TRIGGER decision_topic_exists BEFORE INSERT ON decisions
WHEN NOT EXISTS (SELECT 1 FROM topics WHERE topic_id = NEW.topic_id)
BEGIN SELECT RAISE(ABORT, 'decision references unknown topic'); END;
CREATE TRIGGER decision_topic_exists_update BEFORE UPDATE OF topic_id ON decisions
WHEN NOT EXISTS (SELECT 1 FROM topics WHERE topic_id = NEW.topic_id)
BEGIN SELECT RAISE(ABORT, 'decision references unknown topic'); END;
CREATE TRIGGER commitment_decision_exists BEFORE INSERT ON commitments
WHEN NEW.decision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM decisions WHERE decision_id = NEW.decision_id)
BEGIN SELECT RAISE(ABORT, 'commitment references unknown decision'); END;
CREATE TRIGGER milestone_topic_exists BEFORE INSERT ON milestones
WHEN NOT EXISTS (SELECT 1 FROM topics WHERE topic_id = NEW.topic_id)
BEGIN SELECT RAISE(ABORT, 'milestone references unknown topic'); END;
CREATE TRIGGER decision_state_audit_no_update BEFORE UPDATE ON decision_state_audit
BEGIN SELECT RAISE(ABORT, 'decision state audit is append-only'); END;
CREATE TRIGGER decision_state_audit_no_delete BEFORE DELETE ON decision_state_audit
BEGIN SELECT RAISE(ABORT, 'decision state audit is append-only'); END;
