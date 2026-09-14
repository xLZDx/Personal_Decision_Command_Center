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
  })
  .strict();
export type TopicMutationInput = z.infer<typeof TopicMutation>;

/** Idempotent event attachment; the topic row must exist (migration trigger enforces this). */
export async function attachTopicEvent(
  db: D1Database,
  input: TopicMutationInput,
): Promise<boolean> {
  const value = TopicMutation.parse(input);
  const result = await db
    .prepare(
      `INSERT INTO topic_events (topic_id, event_id, attached_at, attached_by)
     VALUES (?, ?, ?, ?) ON CONFLICT(topic_id, event_id) DO NOTHING`,
    )
    .bind(value.topicId, value.eventId, value.now, value.actor)
    .run();
  return result.meta.changes === 1;
}

export async function detachTopicEvent(
  db: D1Database,
  input: TopicMutationInput,
): Promise<boolean> {
  const value = TopicMutation.parse(input);
  const result = await db
    .prepare('DELETE FROM topic_events WHERE topic_id = ? AND event_id = ?')
    .bind(value.topicId, value.eventId)
    .run();
  return result.meta.changes === 1;
}

/** Atomic merge state transition: move event edges then mark the source topic MERGED. */
export async function mergeTopics(
  db: D1Database,
  input: { sourceTopicId: string; targetTopicId: string; actor: string; now: string },
): Promise<boolean> {
  const value = z
    .object({
      sourceTopicId: MetadataText,
      targetTopicId: MetadataText,
      actor: MetadataText,
      now: z.string().datetime({ offset: true }),
    })
    .strict()
    .parse(input);
  const result = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO topic_events (topic_id, event_id, attached_at, attached_by)
      SELECT ?, event_id, ?, ? FROM topic_events WHERE topic_id = ?`,
      )
      .bind(value.targetTopicId, value.now, value.actor, value.sourceTopicId),
    db
      .prepare(
        `UPDATE topics SET state = 'MERGED', updated_at = ? WHERE topic_id = ? AND topic_id <> ? AND state = 'ACTIVE'`,
      )
      .bind(value.now, value.sourceTopicId, value.targetTopicId),
  ]);
  return Number(result[1]?.meta.changes ?? 0) === 1;
}

/** Idempotently persists an exact source identity mapping; REJECTED mappings retain no person id. */
export async function persistIdentityMapping(
  db: D1Database,
  input: PersistIdentityMappingInput,
): Promise<{ status: 'PERSISTED'; source: Source; sourceIdentity: string }> {
  const value = IdentityInput.parse(input);
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
        JSON.stringify(value.evidenceIds),
        value.now,
        value.source,
        value.sourceIdentity,
        value.auditId,
        value.source,
        value.sourceIdentity,
        value.personId,
        value.state,
        value.actor,
        JSON.stringify(value.evidenceIds),
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
        JSON.stringify(value.evidenceIds),
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
        value.actor,
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
        JSON.stringify(value.evidenceIds),
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
