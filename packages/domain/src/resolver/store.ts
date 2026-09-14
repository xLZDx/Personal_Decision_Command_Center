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
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state !== 'REJECTED' && value.personId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'personId is required unless REJECTED',
      });
    }
  });

export type PersistIdentityMappingInput = z.infer<typeof IdentityInput>;

/** Idempotently persists an exact source identity mapping; REJECTED mappings retain no person id. */
export async function persistIdentityMapping(
  db: D1Database,
  input: PersistIdentityMappingInput,
): Promise<{ status: 'PERSISTED'; source: Source; sourceIdentity: string }> {
  const value = IdentityInput.parse(input);
  await db
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
    )
    .run();
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
        value.assignedBy,
        value.reason,
        value.score,
        value.resolverVersion,
        JSON.stringify(value.evidenceIds),
        value.now,
        value.assignmentId,
      ),
  ];
  await db.batch(statements);
  const row = await db
    .prepare('SELECT assignment_id FROM topic_assignments WHERE event_id = ?')
    .bind(value.eventId)
    .first<{ assignment_id: string }>();
  if (!row) throw new Error('topic assignment was not persisted');
  return {
    status: row.assignment_id === value.assignmentId ? 'PERSISTED' : 'ALREADY_PERSISTED',
    assignmentId: row.assignment_id,
  };
}
