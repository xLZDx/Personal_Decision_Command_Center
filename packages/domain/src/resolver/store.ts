import type { D1Database } from '@cloudflare/workers-types';
import { SourceSchema, type Source } from '@pdos/contracts';
import { z } from 'zod';

const MetadataText = z.string().min(1).max(256);
const AssignmentInput = z
  .object({
    assignmentId: MetadataText,
    eventId: MetadataText,
    topicId: MetadataText,
    resolution: z.enum(['AUTO_ATTACH', 'CANDIDATE_MERGE', 'SEPARATE', 'UNKNOWN']),
    score: z.number().min(0).max(1),
    resolverVersion: z.string().min(1).max(128),
    assignedBy: MetadataText,
    operation: z.enum(['ASSIGN', 'MERGE', 'SPLIT', 'DETACH']),
    reason: z.string().min(1).max(1024),
    evidenceIds: z.array(MetadataText).max(32),
    now: z.string().datetime({ offset: true }),
    auditId: MetadataText,
    actor: MetadataText,
  })
  .strict();

export type PersistTopicAssignmentInput = z.infer<typeof AssignmentInput>;
export type PersistTopicAssignmentResult =
  | { status: 'PERSISTED'; assignmentId: string }
  | { status: 'ALREADY_PERSISTED'; assignmentId: string };

const IdentityInput = z
  .object({
    source: SourceSchema,
    sourceIdentity: MetadataText,
    personId: MetadataText.nullable(),
    state: z.enum(['CONFIRMED', 'SUGGESTED', 'REJECTED']),
    evidenceIds: z.array(MetadataText).max(32),
    now: z.string().datetime({ offset: true }),
    auditId: MetadataText,
    actor: MetadataText,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === 'REJECTED' && value.personId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['personId'],
        message: 'REJECTED mappings must not retain a personId',
      });
    }
    if (value.state !== 'REJECTED' && value.personId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'personId is required unless REJECTED',
      });
    }
  });

export type PersistIdentityMappingInput = z.infer<typeof IdentityInput>;

const TopicMutation = z
  .object({
    topicId: MetadataText,
    eventId: MetadataText,
    actor: MetadataText,
    now: z.string().datetime({ offset: true }),
    auditId: MetadataText,
    reason: z.string().min(1).max(1024),
    evidenceIds: z.array(MetadataText).max(32),
  })
  .strict();
export type TopicMutationInput = z.infer<typeof TopicMutation>;
const SplitMutation = z.object({
  sourceTopicId: MetadataText,
  targetTopicId: MetadataText,
  eventId: MetadataText,
  actor: MetadataText,
  now: z.string().datetime({ offset: true }),
  auditId: MetadataText,
  reason: z.string().min(1).max(1024),
  evidenceIds: z.array(MetadataText).max(32),
}).strict();
export type SplitTopicEventInput = z.infer<typeof SplitMutation>;

/** Idempotent event attachment; the topic row must exist (migration trigger enforces this). */
export async function attachTopicEvent(
  db: D1Database,
  input: TopicMutationInput,
): Promise<boolean> {
  const value = TopicMutation.parse(input);
  const existingAudit = await db.prepare('SELECT operation, topic_id, event_id, actor, reason, evidence_json FROM topic_mutation_audit WHERE audit_id = ?')
    .bind(value.auditId).first<Record<string, string>>();
  if (existingAudit && (existingAudit.operation !== 'ATTACH' || existingAudit.topic_id !== value.topicId || existingAudit.event_id !== value.eventId || existingAudit.actor !== value.actor || existingAudit.reason !== value.reason || existingAudit.evidence_json !== JSON.stringify(value.evidenceIds))) {
    throw new Error('audit id already used for a different mutation');
  }
  const results = await db.batch([
    db.prepare(`INSERT INTO topic_events (topic_id, event_id, attached_at, attached_by)
      VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`)
      .bind(value.topicId, value.eventId, value.now, value.actor),
    db.prepare(`INSERT INTO topic_mutation_audit
      (audit_id, operation, topic_id, event_id, source_topic_id, target_topic_id, actor, reason, evidence_json, created_at)
      SELECT ?, 'ATTACH', ?, ?, NULL, NULL, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM topic_events WHERE topic_id = ? AND event_id = ?)
      ON CONFLICT(audit_id) DO NOTHING`)
      .bind(value.auditId, value.topicId, value.eventId, value.actor, value.reason,
        JSON.stringify(value.evidenceIds), value.now, value.topicId, value.eventId),
  ]);
  return Number(results[0]?.meta.changes ?? 0) === 1;
}

export async function detachTopicEvent(
  db: D1Database,
  input: TopicMutationInput,
): Promise<boolean> {
  const value = TopicMutation.parse(input);
  const existingAudit = await db.prepare('SELECT operation, topic_id, event_id, actor, reason, evidence_json FROM topic_mutation_audit WHERE audit_id = ?')
    .bind(value.auditId).first<Record<string, string>>();
  if (existingAudit && (existingAudit.operation !== 'DETACH' || existingAudit.topic_id !== value.topicId || existingAudit.event_id !== value.eventId || existingAudit.actor !== value.actor || existingAudit.reason !== value.reason || existingAudit.evidence_json !== JSON.stringify(value.evidenceIds))) {
    throw new Error('audit id already used for a different mutation');
  }
  const results = await db.batch([
    db.prepare(`INSERT INTO topic_mutation_audit
      (audit_id, operation, topic_id, event_id, source_topic_id, target_topic_id, actor, reason, evidence_json, created_at)
      SELECT ?, 'DETACH', ?, ?, NULL, NULL, ?, ?, ?, ?
      FROM topic_events WHERE topic_id = ? AND event_id = ?
      ON CONFLICT(audit_id) DO NOTHING`)
      .bind(value.auditId, value.topicId, value.eventId, value.actor, value.reason,
        JSON.stringify(value.evidenceIds), value.now, value.topicId, value.eventId),
    db.prepare('DELETE FROM topic_events WHERE topic_id = ? AND event_id = ?')
      .bind(value.topicId, value.eventId),
  ]);
  return Number(results[1]?.meta.changes ?? 0) === 1;
}

/** Atomically moves one event to another topic and records a reversible SPLIT. */
export async function splitTopicEvent(db: D1Database, input: SplitTopicEventInput): Promise<boolean> {
  const value = SplitMutation.parse(input);
  if (value.sourceTopicId === value.targetTopicId) throw new Error('source and target topics must differ');
  const topics = await db.prepare(`SELECT topic_id, project_id, state FROM topics WHERE topic_id IN (?, ?)`)
    .bind(value.sourceTopicId, value.targetTopicId).all<{ topic_id: string; project_id: string; state: string }>();
  const source = topics.results.find((row) => row.topic_id === value.sourceTopicId);
  const target = topics.results.find((row) => row.topic_id === value.targetTopicId);
  if (!source || !target || source.project_id !== target.project_id || source.state !== 'ACTIVE' || target.state !== 'ACTIVE') {
    throw new Error('topics must be ACTIVE and belong to the same project');
  }
  const evidenceJson = JSON.stringify(value.evidenceIds);
  const existingAudit = await db.prepare('SELECT operation, source_topic_id, target_topic_id, event_id, actor, reason, evidence_json FROM topic_mutation_audit WHERE audit_id = ?')
    .bind(value.auditId).first<Record<string, string>>();
  if (existingAudit) {
    if (existingAudit.operation !== 'SPLIT' || existingAudit.source_topic_id !== value.sourceTopicId || existingAudit.target_topic_id !== value.targetTopicId || existingAudit.event_id !== value.eventId || existingAudit.actor !== value.actor || existingAudit.reason !== value.reason || existingAudit.evidence_json !== evidenceJson) {
      throw new Error('audit id already used for a different mutation');
    }
    return false;
  }
  const results = await db.batch([
    db.prepare(`INSERT INTO topic_mutation_audit
      (audit_id, operation, topic_id, event_id, source_topic_id, target_topic_id, actor, reason, evidence_json, created_at)
      SELECT ?, 'SPLIT', NULL, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM topic_events WHERE topic_id = ? AND event_id = ?)
      ON CONFLICT(audit_id) DO NOTHING`)
      .bind(value.auditId, value.eventId, value.sourceTopicId, value.targetTopicId, value.actor, value.reason, evidenceJson, value.now, value.sourceTopicId, value.eventId),
    db.prepare(`UPDATE topic_events SET topic_id = ?, attached_at = ?, attached_by = ?
      WHERE topic_id = ? AND event_id = ?`)
      .bind(value.targetTopicId, value.now, value.actor, value.sourceTopicId, value.eventId),
  ]);
  return Number(results[1]?.meta.changes ?? 0) === 1;
}

/** Atomic merge state transition: move event edges then mark the source topic MERGED. */
export async function mergeTopics(
  db: D1Database,
  input: { sourceTopicId: string; targetTopicId: string; actor: string; now: string; auditId: string; reason: string; evidenceIds: string[] },
): Promise<boolean> {
  const value = z
    .object({
      sourceTopicId: MetadataText,
      targetTopicId: MetadataText,
      actor: MetadataText,
      now: z.string().datetime({ offset: true }),
      auditId: MetadataText,
      reason: z.string().min(1).max(1024),
      evidenceIds: z.array(MetadataText).max(32),
    })
    .strict()
    .parse(input);
  if (value.sourceTopicId === value.targetTopicId) throw new Error('source and target topics must differ');
  const evidenceJson = JSON.stringify(value.evidenceIds);
  const existingAudit = await db.prepare('SELECT operation, source_topic_id, target_topic_id, actor, reason, evidence_json FROM topic_mutation_audit WHERE audit_id = ?')
    .bind(value.auditId).first<Record<string, string>>();
  if (existingAudit) {
    if (existingAudit.operation !== 'MERGE' || existingAudit.source_topic_id !== value.sourceTopicId || existingAudit.target_topic_id !== value.targetTopicId || existingAudit.actor !== value.actor || existingAudit.reason !== value.reason || existingAudit.evidence_json !== evidenceJson) {
      throw new Error('audit id already used for a different mutation');
    }
    return false;
  }
  const topics = await db.prepare(`SELECT topic_id, project_id, state FROM topics WHERE topic_id IN (?, ?)`)
    .bind(value.sourceTopicId, value.targetTopicId).all<{ topic_id: string; project_id: string; state: string }>();
  if (topics.results.length !== 2) throw new Error('source and target topics must exist');
  const source = topics.results.find((row) => row.topic_id === value.sourceTopicId);
  const target = topics.results.find((row) => row.topic_id === value.targetTopicId);
  if (!source || !target || source.project_id !== target.project_id || source.state !== 'ACTIVE' || target.state !== 'ACTIVE') {
    throw new Error('topics must be ACTIVE and belong to the same project');
  }
  const result = await db.batch([
    db
      .prepare(
        `INSERT INTO topic_mutation_audit
          (audit_id, operation, topic_id, event_id, source_topic_id, target_topic_id, actor, reason, evidence_json, created_at)
         SELECT ?, 'MERGE', NULL, NULL, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM topics source JOIN topics target ON target.topic_id = ?
           WHERE source.topic_id = ? AND source.project_id = target.project_id
             AND source.state = 'ACTIVE' AND target.state = 'ACTIVE')
         ON CONFLICT(audit_id) DO NOTHING`,
      )
      .bind(value.auditId, value.sourceTopicId, value.targetTopicId, value.actor, value.reason,
        JSON.stringify(value.evidenceIds), value.now, value.targetTopicId, value.sourceTopicId),
    db
      .prepare(
        `DELETE FROM topic_events WHERE topic_id = ? AND event_id IN
          (SELECT event_id FROM topic_events WHERE topic_id = ?)`
      )
      .bind(value.sourceTopicId, value.targetTopicId),
    db
      .prepare(
        `UPDATE topic_events SET topic_id = ? WHERE topic_id = ?`,
      )
      .bind(value.targetTopicId, value.sourceTopicId),
    db.prepare(`UPDATE topic_assignments SET topic_id = ? WHERE topic_id = ?`)
      .bind(value.targetTopicId, value.sourceTopicId),
    db.prepare(`UPDATE topics SET state = 'MERGED', updated_at = ?
      WHERE topic_id = ? AND topic_id <> ? AND state = 'ACTIVE'
      AND EXISTS (SELECT 1 FROM topics target WHERE target.topic_id = ?
        AND target.project_id = topics.project_id AND target.state = 'ACTIVE')`)
      .bind(value.now, value.sourceTopicId, value.targetTopicId, value.targetTopicId),
  ]);
  return Number(result[4]?.meta.changes ?? 0) === 1;
}

/** Idempotently persists an exact source identity mapping; REJECTED mappings retain no person id. */
export async function persistIdentityMapping(
  db: D1Database,
  input: PersistIdentityMappingInput,
): Promise<{ status: 'PERSISTED'; source: Source; sourceIdentity: string }> {
  const value = IdentityInput.parse(input);
  const evidenceJson = JSON.stringify(value.evidenceIds);
  const existingAudit = await db.prepare(`SELECT source, source_identity, next_person_id, next_state, actor, evidence_json
      FROM source_identity_audit WHERE audit_id = ?`).bind(value.auditId)
    .first<{ source: string; source_identity: string; next_person_id: string | null; next_state: string; actor: string; evidence_json: string }>();
  if (existingAudit && (existingAudit.source !== value.source || existingAudit.source_identity !== value.sourceIdentity || existingAudit.next_person_id !== value.personId || existingAudit.next_state !== value.state || existingAudit.actor !== value.actor || existingAudit.evidence_json !== evidenceJson)) {
    throw new Error('audit id already used for a different identity mapping');
  }
  await db.batch([
    db
      .prepare(
        `INSERT INTO source_identity_audit
          (audit_id, source, source_identity, previous_person_id, next_person_id, previous_state, next_state, actor, evidence_json, created_at)
         SELECT ?, source, source_identity, person_id, ?, state, ?, ?, ?, ?
         FROM source_identities WHERE source = ? AND source_identity = ?
         UNION ALL SELECT ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM source_identities WHERE source = ? AND source_identity = ?)
         ON CONFLICT(audit_id) DO NOTHING`,
      )
      .bind(
        value.auditId,
        value.personId,
        value.state,
        value.actor,
        evidenceJson,
        value.now,
        value.source,
        value.sourceIdentity,
        value.auditId,
        value.source,
        value.sourceIdentity,
        value.personId,
        value.state,
        value.actor,
        evidenceJson,
        value.now,
        value.source,
        value.sourceIdentity,
      ),
    db
      .prepare(
        `INSERT INTO source_identities
        (source, source_identity, person_id, state, evidence_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, source_identity) DO UPDATE SET
         person_id = excluded.person_id, state = excluded.state,
         evidence_json = excluded.evidence_json, updated_at = excluded.updated_at`,
      )
      .bind(
        value.source,
        value.sourceIdentity,
        value.personId,
        value.state,
        evidenceJson,
        value.now,
        value.now,
      ),
  ]);
  return { status: 'PERSISTED', source: value.source, sourceIdentity: value.sourceIdentity };
}

/** Persists resolver metadata and its audit edge atomically and idempotently. */
export async function persistTopicAssignment(
  db: D1Database,
  input: PersistTopicAssignmentInput,
): Promise<PersistTopicAssignmentResult> {
  const value = AssignmentInput.parse(input);
  const evidenceJson = JSON.stringify(value.evidenceIds);
  const existingAudit = await db.prepare(`SELECT assignment_id, event_id, operation, actor, reason, score, resolver_version, evidence_json
      FROM topic_assignment_audit WHERE audit_id = ?`).bind(value.auditId)
    .first<{ assignment_id: string; event_id: string; operation: string; actor: string; reason: string; score: number; resolver_version: string; evidence_json: string }>();
  if (existingAudit && (existingAudit.assignment_id !== value.assignmentId || existingAudit.event_id !== value.eventId || existingAudit.operation !== value.operation || existingAudit.actor !== value.actor || existingAudit.reason !== value.reason || Number(existingAudit.score) !== value.score || existingAudit.resolver_version !== value.resolverVersion || existingAudit.evidence_json !== evidenceJson)) {
    throw new Error('audit id already used for a different topic assignment');
  }
  const statements = [
    db
      .prepare(
        `INSERT INTO topic_assignments
          (assignment_id, event_id, topic_id, resolution, score, resolver_version, assigned_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .bind(
        value.assignmentId,
        value.eventId,
        value.topicId,
        value.resolution,
        value.score,
        value.resolverVersion,
        value.assignedBy,
        value.now,
        value.now,
      ),
    db
      .prepare(
        `INSERT INTO topic_assignment_audit
          (audit_id, assignment_id, event_id, operation, actor, reason, score, resolver_version, evidence_json, created_at)
         SELECT ?, assignment_id, event_id, ?, ?, ?, ?, ?, ?, ?
         FROM topic_assignments WHERE assignment_id = ?
         ON CONFLICT(audit_id) DO NOTHING`,
      )
      .bind(
        value.auditId,
        value.operation,
        value.actor,
        value.reason,
        value.score,
        value.resolverVersion,
        evidenceJson,
        value.now,
        value.assignmentId,
      ),
  ];
  const results = await db.batch(statements);
  const row = await db
    .prepare('SELECT assignment_id FROM topic_assignments WHERE event_id = ?')
    .bind(value.eventId)
    .first<{ assignment_id: string }>();
  if (!row) throw new Error('topic assignment was not persisted');
  return {
    status:
      Number(results[0]?.meta.changes ?? 0) === 1 && row.assignment_id === value.assignmentId
        ? 'PERSISTED'
        : 'ALREADY_PERSISTED',
    assignmentId: row.assignment_id,
  };
}
