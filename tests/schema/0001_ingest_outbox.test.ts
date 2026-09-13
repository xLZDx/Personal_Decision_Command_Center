import { describe, expect, it } from 'vitest';
import { createTestD1, loadG2Schema, seedBaselineAccounts, seedEvent } from '@pdos/testkit';

/**
 * Schema-integrity controls for `infra/migrations/0001_ingest_outbox.sql`. These were originally
 * validated ad hoc against a Python/sqlite3 scratch harness during the G2 architecture review
 * (`D:\Temp\...\scratchpad\g2v2\validate.py`/`validate3.py`, cited in core/DECISION_LOG.md) -- this
 * file ports every one of those negative/positive controls into the real, executed vitest suite,
 * against the actual migration file (via `@pdos/testkit`'s `loadG2Schema`), not a hand-copied
 * fragment of it. A CHECK/FK constraint with no test protecting it can be silently weakened or
 * removed in a future edit with nothing failing.
 */

const NOW = '2026-09-13T00:00:00.000Z';

function freshDb() {
  return createTestD1(loadG2Schema());
}

describe('source_policies', () => {
  it('rejects telegram + ALLOW (core/SOURCE_POLICY.md binding default)', async () => {
    const db = freshDb();
    await expect(
      db
        .prepare(
          'INSERT INTO source_policies (source_policy_id, source, ai_policy, version, created_at) VALUES (?,?,?,?,?)',
        )
        .bind('pol-bad', 'telegram', 'ALLOW', 1, NOW)
        .run(),
    ).rejects.toThrow();
  });
});

describe('ingest_events source/account integrity', () => {
  it("rejects an event whose source does not match its source_account_id's own source (composite FK)", async () => {
    const db = freshDb();
    const accounts = await seedBaselineAccounts(db);
    await expect(
      seedEvent(db, accounts, {
        eventId: 'ev-mismatch',
        source: 'gmail',
        sourceAccountId: accounts.telegramAccountId,
      }),
    ).rejects.toThrow();
  });

  it('accepts an event whose source matches its account everywhere (positive control)', async () => {
    const db = freshDb();
    const accounts = await seedBaselineAccounts(db);
    await expect(
      seedEvent(db, accounts, { eventId: 'ev-ok', source: 'gmail' }),
    ).resolves.not.toThrow();
  });

  it('rejects a source_policy_id/source pair that does not match a real source_policies row', async () => {
    const db = freshDb();
    const accounts = await seedBaselineAccounts(db);
    await expect(
      seedEvent(db, accounts, {
        eventId: 'ev-badpolicy',
        source: 'gmail',
        sourcePolicyId: accounts.telegramPolicyId,
      }),
    ).rejects.toThrow();
  });
});

describe('MESSAGE_UPDATED source_version requirement', () => {
  it('rejects MESSAGE_UPDATED with no source_version', async () => {
    const db = freshDb();
    const accounts = await seedBaselineAccounts(db);
    await expect(
      seedEvent(db, accounts, {
        eventId: 'ev-upd-bad',
        eventType: 'MESSAGE_UPDATED',
        sourceVersion: null,
      }),
    ).rejects.toThrow();
  });

  it('accepts MESSAGE_UPDATED with a real source_version (positive control)', async () => {
    const db = freshDb();
    const accounts = await seedBaselineAccounts(db);
    await expect(
      seedEvent(db, accounts, {
        eventId: 'ev-upd-ok',
        eventType: 'MESSAGE_UPDATED',
        sourceVersion: 'rev-1',
      }),
    ).resolves.not.toThrow();
  });
});

describe('idempotency_key uniqueness', () => {
  it('a retried submission of the same revision (identical idempotency_key) collides', async () => {
    const db = freshDb();
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, {
      eventId: 'ev-v1',
      eventType: 'MESSAGE_UPDATED',
      sourceVersion: 'rev-1',
      idempotencyKey: 'idem-shared',
    });
    await expect(
      seedEvent(db, accounts, {
        eventId: 'ev-v1-retry',
        eventType: 'MESSAGE_UPDATED',
        sourceVersion: 'rev-1',
        idempotencyKey: 'idem-shared',
      }),
    ).rejects.toThrow();
  });

  it('a genuinely different revision (different idempotency_key) does not collide', async () => {
    const db = freshDb();
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, {
      eventId: 'ev-v1',
      eventType: 'MESSAGE_UPDATED',
      sourceVersion: 'rev-1',
      idempotencyKey: 'idem-rev-1',
    });
    await expect(
      seedEvent(db, accounts, {
        eventId: 'ev-v2',
        eventType: 'MESSAGE_UPDATED',
        sourceVersion: 'rev-2',
        idempotencyKey: 'idem-rev-2',
      }),
    ).resolves.not.toThrow();
  });
});

describe('processing-lease state bindings', () => {
  it('rejects a DLQ row with a live (non-null) lease', async () => {
    const db = freshDb();
    const accounts = await seedBaselineAccounts(db);
    await expect(
      seedEvent(db, accounts, {
        eventId: 'ev-dlq-lease',
        state: 'DLQ',
        attemptCount: 5,
        leaseOwner: 'owner-x',
        leaseToken: 'token-x',
        leaseExpiresAt: '2026-09-13T00:02:00.000Z',
        firstFailedAt: NOW,
      }),
    ).rejects.toThrow();
  });

  it('rejects a PROCESSING row with no lease (the inverse case)', async () => {
    const db = freshDb();
    const accounts = await seedBaselineAccounts(db);
    await expect(
      seedEvent(db, accounts, {
        eventId: 'ev-processing-nolease',
        state: 'PROCESSING',
        attemptCount: 1,
      }),
    ).rejects.toThrow();
  });

  it('rejects PROCESSING with a lease owner/expiry but no token (token is the sole CAS fence)', async () => {
    const db = freshDb();
    const accounts = await seedBaselineAccounts(db);
    await expect(
      seedEvent(db, accounts, {
        eventId: 'ev-notoken',
        state: 'PROCESSING',
        attemptCount: 1,
        leaseOwner: 'worker-1',
        leaseToken: null,
        leaseExpiresAt: '2026-09-13T00:02:00.000Z',
      }),
    ).rejects.toThrow();
  });

  it('rejects a DLQ row with zero attempts (must have burned at least one)', async () => {
    const db = freshDb();
    const accounts = await seedBaselineAccounts(db);
    await expect(
      seedEvent(db, accounts, {
        eventId: 'ev-dlq-zero',
        state: 'DLQ',
        attemptCount: 0,
        firstFailedAt: NOW,
      }),
    ).rejects.toThrow();
  });

  it('accepts a valid PROCESSING row with a full lease (positive control)', async () => {
    const db = freshDb();
    const accounts = await seedBaselineAccounts(db);
    await expect(
      seedEvent(db, accounts, {
        eventId: 'ev-processing-ok',
        state: 'PROCESSING',
        attemptCount: 1,
        leaseOwner: 'worker-1',
        leaseToken: 'token-1',
        leaseExpiresAt: '2026-09-13T00:02:00.000Z',
      }),
    ).resolves.not.toThrow();
  });

  it('accepts a valid DLQ row with attempts >= 1 and no lease (positive control)', async () => {
    const db = freshDb();
    const accounts = await seedBaselineAccounts(db);
    await expect(
      seedEvent(db, accounts, {
        eventId: 'ev-dlq-ok',
        state: 'DLQ',
        attemptCount: 5,
        firstFailedAt: NOW,
      }),
    ).resolves.not.toThrow();
  });
});

describe('ingest_event_routing_hint_provenance FK', () => {
  it('rejects a provenance edge citing an event that does not exist', async () => {
    const db = freshDb();
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, { eventId: 'ev-host' });
    await db
      .prepare(
        `INSERT INTO ingest_event_routing_hints
           (event_id, hint_index, value, derivation_method, ai_policy, sensitivity, created_at, derivation_version)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind('ev-host', 0, 'hint-value', 'RULE', 'DENY', 'general', NOW, 1)
      .run();
    await expect(
      db
        .prepare(
          'INSERT INTO ingest_event_routing_hint_provenance (event_id, hint_index, provenance_event_id) VALUES (?,?,?)',
        )
        .bind('ev-host', 0, 'event-that-does-not-exist')
        .run(),
    ).rejects.toThrow();
  });

  it('accepts a provenance edge citing a real event (positive control)', async () => {
    const db = freshDb();
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, { eventId: 'ev-ancestor' });
    await seedEvent(db, accounts, { eventId: 'ev-host' });
    await db
      .prepare(
        `INSERT INTO ingest_event_routing_hints
           (event_id, hint_index, value, derivation_method, ai_policy, sensitivity, created_at, derivation_version)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind('ev-host', 0, 'hint-value', 'RULE', 'DENY', 'general', NOW, 1)
      .run();
    await expect(
      db
        .prepare(
          'INSERT INTO ingest_event_routing_hint_provenance (event_id, hint_index, provenance_event_id) VALUES (?,?,?)',
        )
        .bind('ev-host', 0, 'ev-ancestor')
        .run(),
    ).resolves.not.toThrow();
  });
});

describe('ingest_event_routing_hints (ProvenanceValue<T> wrapper columns)', () => {
  async function seedHost(db: ReturnType<typeof freshDb>) {
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, { eventId: 'ev-host' });
  }

  it('rejects a NULL sensitivity', async () => {
    const db = freshDb();
    await seedHost(db);
    await expect(
      db
        .prepare(
          `INSERT INTO ingest_event_routing_hints
             (event_id, hint_index, value, derivation_method, ai_policy, sensitivity, created_at, derivation_version)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind('ev-host', 0, 'v', 'RULE', 'DENY', null, NOW, 1)
        .run(),
    ).rejects.toThrow();
  });

  it('rejects an empty-string sensitivity', async () => {
    const db = freshDb();
    await seedHost(db);
    await expect(
      db
        .prepare(
          `INSERT INTO ingest_event_routing_hints
             (event_id, hint_index, value, derivation_method, ai_policy, sensitivity, created_at, derivation_version)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind('ev-host', 0, 'v', 'RULE', 'DENY', '', NOW, 1)
        .run(),
    ).rejects.toThrow();
  });

  it('rejects a missing created_at', async () => {
    const db = freshDb();
    await seedHost(db);
    await expect(
      db
        .prepare(
          `INSERT INTO ingest_event_routing_hints
             (event_id, hint_index, value, derivation_method, ai_policy, sensitivity, created_at, derivation_version)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind('ev-host', 0, 'v', 'RULE', 'DENY', 'general', null, 1)
        .run(),
    ).rejects.toThrow();
  });

  it('rejects a non-positive derivation_version', async () => {
    const db = freshDb();
    await seedHost(db);
    await expect(
      db
        .prepare(
          `INSERT INTO ingest_event_routing_hints
             (event_id, hint_index, value, derivation_method, ai_policy, sensitivity, created_at, derivation_version)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind('ev-host', 0, 'v', 'RULE', 'DENY', 'general', NOW, 0)
        .run(),
    ).rejects.toThrow();
  });

  it('accepts a well-formed routing hint (positive control)', async () => {
    const db = freshDb();
    await seedHost(db);
    await expect(
      db
        .prepare(
          `INSERT INTO ingest_event_routing_hints
             (event_id, hint_index, value, derivation_method, ai_policy, sensitivity, created_at, derivation_version)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind('ev-host', 0, 'v', 'RULE', 'DENY', 'general', NOW, 1)
        .run(),
    ).resolves.not.toThrow();
  });
});

describe('queue_budget_counters hard ceiling', () => {
  it('rejects a counter above 2500', async () => {
    const db = freshDb();
    await expect(
      db
        .prepare('INSERT INTO queue_budget_counters (day, dispatched_count) VALUES (?, ?)')
        .bind('2026-09-13', 2501)
        .run(),
    ).rejects.toThrow();
  });

  it('accepts a counter at exactly 2500 (positive control)', async () => {
    const db = freshDb();
    await expect(
      db
        .prepare('INSERT INTO queue_budget_counters (day, dispatched_count) VALUES (?, ?)')
        .bind('2026-09-13', 2500)
        .run(),
    ).resolves.not.toThrow();
  });
});

describe('query-plan index coverage', () => {
  it('the reconciler eligibility query (Phase 2) uses idx_processing_outbox_due, not a full scan', async () => {
    const db = freshDb();
    const plan = await db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT o.event_id FROM processing_outbox AS o
         JOIN ingest_events AS e ON e.event_id = o.event_id
         WHERE o.state <> 'CLOSED' AND o.next_attempt_at <= ?
           AND e.state IN ('ACCEPTED', 'RETRYABLE_FAILED') AND e.processing_attempt_count < ?
         ORDER BY o.next_attempt_at LIMIT 25`,
      )
      .bind(NOW, 5)
      .all<{ detail: string }>();
    const detail = plan.results.map((r) => r.detail).join(' | ');
    expect(detail).toContain('idx_processing_outbox_due');
  });

  it('the lease-expiry sweep query (Phase 1) uses idx_ingest_events_processing_lease, not a full scan', async () => {
    const db = freshDb();
    const plan = await db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT event_id FROM ingest_events
         WHERE state = 'PROCESSING' AND processing_lease_expires_at <= ?
         ORDER BY processing_lease_expires_at LIMIT 10`,
      )
      .bind(NOW)
      .all<{ detail: string }>();
    const detail = plan.results.map((r) => r.detail).join(' | ');
    expect(detail).toContain('idx_ingest_events_processing_lease');
  });
});
