import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { persistIdentityMapping, persistTopicAssignment } from '../../src/index.js';
import { createTestD1 } from '../../../testkit/src/index.js';

describe('resolver durable store', () => {
  it('persists assignment metadata and an audit row idempotently', async () => {
    const schema =
      readFileSync(
        new URL('../../../../infra/migrations/0011_resolver_state.sql', import.meta.url),
        'utf8',
      ) +
      readFileSync(
        new URL('../../../../infra/migrations/0013_g5_core_entities.sql', import.meta.url),
        'utf8',
      );
    const db = createTestD1(schema);
    const input = {
      assignmentId: 'assignment-1',
      eventId: 'event-1',
      topicId: 'topic-1',
      resolution: 'CANDIDATE_MERGE' as const,
      score: 0.75,
      resolverVersion: 'g5-resolver-v1',
      assignedBy: 'operator-1',
      operation: 'MERGE' as const,
      reason: 'matching confirmed metadata',
      evidenceIds: ['event-1', 'event-2'],
      now: '2026-09-14T10:00:00.000Z',
      auditId: 'audit-1',
      actor: 'operator-1',
    };
    await expect(persistTopicAssignment(db, input)).resolves.toEqual({
      status: 'PERSISTED',
      assignmentId: 'assignment-1',
    });
    await expect(persistTopicAssignment(db, input)).resolves.toEqual({
      status: 'ALREADY_PERSISTED',
      assignmentId: 'assignment-1',
    });
    const audit = await db
      .prepare('SELECT count(*) AS count FROM topic_assignment_audit')
      .first<{ count: number }>();
    expect(Number(audit?.count)).toBe(1);
  });

  it('persists rejected identity mappings without a person id', async () => {
    const schema =
      readFileSync(
        new URL('../../../../infra/migrations/0011_resolver_state.sql', import.meta.url),
        'utf8',
      ) +
      readFileSync(
        new URL('../../../../infra/migrations/0013_g5_core_entities.sql', import.meta.url),
        'utf8',
      );
    const db = createTestD1(schema);
    await expect(
      persistIdentityMapping(db, {
        source: 'telegram',
        sourceIdentity: 'tg:42',
        personId: null,
        state: 'REJECTED',
        evidenceIds: ['event-9'],
        now: '2026-09-14T10:00:00.000Z',
        auditId: 'identity-audit-1',
        actor: 'operator-1',
      }),
    ).resolves.toMatchObject({ status: 'PERSISTED', source: 'telegram' });
    await expect(
      persistIdentityMapping(db, {
        source: 'telegram',
        sourceIdentity: 'tg:42',
        personId: null,
        state: 'REJECTED',
        evidenceIds: ['event-9'],
        now: '2026-09-14T10:00:00.000Z',
        auditId: 'identity-audit-1',
        actor: 'operator-1',
      }),
    ).resolves.toMatchObject({ status: 'PERSISTED' });
    await expect(
      persistIdentityMapping(db, {
        source: 'telegram',
        sourceIdentity: 'tg:43',
        personId: 'person-1',
        state: 'REJECTED',
        evidenceIds: ['event-9'],
        now: '2026-09-14T10:00:00.000Z',
        auditId: 'identity-audit-2',
        actor: 'operator-1',
      }),
    ).rejects.toThrow();
  });
});
