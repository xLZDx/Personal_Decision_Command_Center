import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';

const Id = z.string().min(1).max(256);
const DecisionState = z.enum(['OPEN', 'NEEDS_REVIEW', 'SNOOZED', 'RESOLVED', 'CANCELLED']);
const DecisionInput = z
  .object({
    decisionId: Id,
    topicId: Id,
    state: DecisionState,
    owner: Id,
    recommendation: z.string().max(1024).nullable(),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']),
    evidenceIds: z.array(Id).min(1).max(32),
    aiPolicy: z.enum(['ALLOW', 'DENY']),
    now: z.string().datetime({ offset: true }),
    auditId: Id,
    actor: Id,
  })
  .strict();
export type PersistDecisionInput = z.infer<typeof DecisionInput>;

/** Durable, idempotent decision write plus append-only state audit. */
export async function persistDecision(
  db: D1Database,
  input: PersistDecisionInput,
): Promise<boolean> {
  const value = DecisionInput.parse(input);
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO decision_state_audit
      (audit_id, entity_type, entity_id, from_state, to_state, actor, evidence_json, created_at)
      SELECT ?, 'DECISION', decision_id, state, ?, ?, ?, ? FROM decisions WHERE decision_id = ?
      UNION ALL SELECT ?, 'DECISION', ?, NULL, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM decisions WHERE decision_id = ?)
      ON CONFLICT(audit_id) DO NOTHING`,
      )
      .bind(
        value.auditId,
        value.state,
        value.actor,
        JSON.stringify(value.evidenceIds),
        value.now,
        value.decisionId,
        value.auditId,
        value.decisionId,
        value.state,
        value.actor,
        JSON.stringify(value.evidenceIds),
        value.now,
        value.decisionId,
      ),
    db
      .prepare(
        `INSERT INTO decisions
      (decision_id, topic_id, state, owner, recommendation, priority, evidence_json, ai_policy, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(decision_id) DO UPDATE SET state=excluded.state, owner=excluded.owner,
      recommendation=excluded.recommendation, priority=excluded.priority, evidence_json=excluded.evidence_json,
      ai_policy=excluded.ai_policy, updated_at=excluded.updated_at`,
      )
      .bind(
        value.decisionId,
        value.topicId,
        value.state,
        value.owner,
        value.recommendation,
        value.priority,
        JSON.stringify(value.evidenceIds),
        value.aiPolicy,
        value.now,
        value.now,
      ),
  ]);
  return Number(results[1]?.meta.changes ?? 0) === 1;
}
