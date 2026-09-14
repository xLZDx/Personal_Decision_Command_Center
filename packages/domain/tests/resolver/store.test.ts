import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  attachTopicEvent,
  detachTopicEvent,
  mergeTopics,
  splitTopicEvent,
  persistIdentityMapping,
  persistTopicAssignment,
} from '../../src/index.js';
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
      ) +
      readFileSync(
        new URL('../../../../infra/migrations/0014_g5_integrity_triggers.sql', import.meta.url),
        'utf8',
      );
    const db = createTestD1(schema);
    await db
      .prepare(
        "INSERT INTO projects VALUES ('p', 'erp', 'ERP', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO topics VALUES ('topic-1', 'p', NULL, 'ERP::1', 'ACTIVE', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z')",
      )
      .run();
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
    await expect(
      persistIdentityMapping(db, {
        source: 'telegram',
        sourceIdentity: 'tg:42',
        personId: null,
        state: 'REJECTED',
        evidenceIds: ['different-evidence'],
        now: '2026-09-14T10:00:00.000Z',
        auditId: 'identity-audit-1',
        actor: 'operator-1',
      }),
    ).rejects.toThrow(/audit id/);
  });

  it('attaches, detaches and merges topic event edges transactionally', async () => {
    const schema =
      readFileSync(
        new URL('../../../../infra/migrations/0011_resolver_state.sql', import.meta.url),
        'utf8',
      ) +
      readFileSync(
        new URL('../../../../infra/migrations/0013_g5_core_entities.sql', import.meta.url),
        'utf8',
      ) +
      readFileSync(
        new URL('../../../../infra/migrations/0014_g5_integrity_triggers.sql', import.meta.url),
        'utf8',
      );
    const db = createTestD1(schema);
    await db
      .prepare(
        "INSERT INTO projects VALUES ('p', 'erp', 'ERP', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO topics VALUES ('t1', 'p', NULL, 'ERP::1', 'ACTIVE', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO topics VALUES ('t2', 'p', NULL, 'ERP::2', 'ACTIVE', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z')",
      )
      .run();
    expect(
      await attachTopicEvent(db, {
        topicId: 't1',
        eventId: 'e1',
        actor: 'op',
        now: '2026-09-14T10:00:00.000Z',
        auditId: 'm-attach-1',
        reason: 'operator confirmed topic',
        evidenceIds: ['e1'],
      }),
    ).toBe(true);
    expect(
      await mergeTopics(db, {
        sourceTopicId: 't1',
        targetTopicId: 't2',
        actor: 'op',
        now: '2026-09-14T10:00:00.000Z',
        auditId: 'm-merge-1',
        reason: 'same business topic',
        evidenceIds: ['e1'],
      }),
    ).toBe(true);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM topic_events WHERE topic_id = 't2'")
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(
      await detachTopicEvent(db, {
        topicId: 't2',
        eventId: 'e1',
        actor: 'op',
        now: '2026-09-14T10:00:00.000Z',
        auditId: 'm-detach-1',
        reason: 'operator split correction',
        evidenceIds: ['e1'],
      }),
    ).toBe(true);
  });

  it('rejects cross-project merges and duplicate event attachment', async () => {
    const schema =
      readFileSync(new URL('../../../../infra/migrations/0011_resolver_state.sql', import.meta.url), 'utf8') +
      readFileSync(new URL('../../../../infra/migrations/0013_g5_core_entities.sql', import.meta.url), 'utf8') +
      readFileSync(new URL('../../../../infra/migrations/0014_g5_integrity_triggers.sql', import.meta.url), 'utf8');
    const db = createTestD1(schema);
    await db.prepare("INSERT INTO projects VALUES ('p1', 'one', 'One', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z'), ('p2', 'two', 'Two', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z')").run();
    await db.prepare("INSERT INTO topics VALUES ('t1', 'p1', NULL, 'ONE::1', 'ACTIVE', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z'), ('t2', 'p2', NULL, 'TWO::1', 'ACTIVE', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z')").run();
    const mutation = { topicId: 't1', eventId: 'e1', actor: 'op', now: '2026-09-14T10:00:00.000Z', auditId: 'm-1', reason: 'attach', evidenceIds: ['e1'] };
    await expect(attachTopicEvent(db, mutation)).resolves.toBe(true);
    await expect(attachTopicEvent(db, { ...mutation, topicId: 't2', auditId: 'm-2' })).resolves.toBe(false);
    await expect(mergeTopics(db, { sourceTopicId: 't1', targetTopicId: 't2', actor: 'op', now: mutation.now, auditId: 'm-3', reason: 'cross project', evidenceIds: ['e1'] })).rejects.toThrow(/same project/);
    const row = await db.prepare("SELECT topic_id FROM topic_events WHERE event_id = 'e1'").first<{ topic_id: string }>();
    expect(row?.topic_id).toBe('t1');
    await expect(db.prepare("UPDATE topic_mutation_audit SET reason = 'tamper' WHERE audit_id = 'm-1'").run()).rejects.toThrow(/append-only/);
  });

  it('supports audited manual split without duplicate membership', async () => {
    const schema =
      readFileSync(new URL('../../../../infra/migrations/0011_resolver_state.sql', import.meta.url), 'utf8') +
      readFileSync(new URL('../../../../infra/migrations/0013_g5_core_entities.sql', import.meta.url), 'utf8') +
      readFileSync(new URL('../../../../infra/migrations/0014_g5_integrity_triggers.sql', import.meta.url), 'utf8');
    const db = createTestD1(schema);
    await db.prepare("INSERT INTO projects VALUES ('p', 'one', 'One', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z')").run();
    await db.prepare("INSERT INTO topics VALUES ('t1', 'p', NULL, 'ONE::1', 'ACTIVE', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z'), ('t2', 'p', NULL, 'ONE::2', 'ACTIVE', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z')").run();
    await attachTopicEvent(db, { topicId: 't1', eventId: 'e1', actor: 'op', now: '2026-09-14T10:00:00.000Z', auditId: 'a1', reason: 'initial', evidenceIds: ['e1'] });
    await expect(splitTopicEvent(db, { sourceTopicId: 't1', targetTopicId: 't2', eventId: 'e1', actor: 'op', now: '2026-09-14T10:00:00.000Z', auditId: 'a2', reason: 'manual split', evidenceIds: ['e1'] })).resolves.toBe(true);
    const row = await db.prepare("SELECT topic_id FROM topic_events WHERE event_id = 'e1'").first<{ topic_id: string }>();
    expect(row?.topic_id).toBe('t2');
    const audit = await db.prepare("SELECT operation FROM topic_mutation_audit WHERE audit_id = 'a2'").first<{ operation: string }>();
    expect(audit?.operation).toBe('SPLIT');
  });
});
