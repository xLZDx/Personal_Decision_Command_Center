import { describe, expect, it } from 'vitest';
import { createTestD1, loadG3Schema, seedBaselineAccounts, FIXTURE_NOW } from '@pdos/testkit';

import { claimOrInspectDelivery, completeDelivery } from '../../src/gmail/push-lease.js';
import { recoverStalePushDeliveries } from '../../src/gmail/push-lease-recovery.js';

const LEASE_MS = 120_000;

async function setup() {
  const db = createTestD1(loadG3Schema());
  const accounts = await seedBaselineAccounts(db);
  return { db, gmailAccountId: accounts.gmailAccountId };
}

async function seedInProgress(
  db: Awaited<ReturnType<typeof setup>>['db'],
  gmailAccountId: string,
  messageId: string,
  claimedAt: string,
) {
  const result = await claimOrInspectDelivery(db, {
    messageId,
    gmailAccountId,
    startHistoryId: `h-${messageId}`,
    now: claimedAt,
    leaseDurationMs: LEASE_MS,
  });
  if (result.outcome !== 'WON') throw new Error('unreachable');
  return result.token;
}

describe('recoverStalePushDeliveries', () => {
  it('reclaims a genuinely expired IN_PROGRESS row, returning enough to resume it', async () => {
    const { db, gmailAccountId } = await setup();
    await seedInProgress(db, gmailAccountId, 'm-1', '2026-09-13T00:00:00.000Z');

    const recovered = await recoverStalePushDeliveries(db, {
      now: '2026-09-13T00:05:00.000Z',
      batchSize: 10,
      leaseDurationMs: LEASE_MS,
    });

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      messageId: 'm-1',
      gmailAccountId,
      startHistoryId: 'h-m-1',
      outcome: 'RECLAIMED',
    });
    expect(recovered[0]?.token).toBeDefined();
  });

  it('does not select a lease whose expiry is still in the future', async () => {
    const { db, gmailAccountId } = await setup();
    await seedInProgress(db, gmailAccountId, 'm-2', '2026-09-13T00:00:00.000Z');

    const recovered = await recoverStalePushDeliveries(db, {
      now: '2026-09-13T00:00:30.000Z', // well within LEASE_MS
      batchSize: 10,
      leaseDurationMs: LEASE_MS,
    });
    expect(recovered).toEqual([]);
  });

  it('never selects a COMPLETED row, even with an old timestamp', async () => {
    const { db, gmailAccountId } = await setup();
    const token = await seedInProgress(db, gmailAccountId, 'm-3', '2026-09-13T00:00:00.000Z');
    await completeDelivery(db, { messageId: 'm-3', token, now: '2026-09-13T00:00:01.000Z' });

    const recovered = await recoverStalePushDeliveries(db, {
      now: '2026-09-13T00:05:00.000Z',
      batchSize: 10,
      leaseDurationMs: LEASE_MS,
    });
    expect(recovered).toEqual([]);
  });

  it(
    'functional correctness with many retained COMPLETED rows present: the sweep still finds and ' +
      'reclaims exactly the active set (the actual partiality guarantee is asserted directly by ' +
      "the dedicated 'is a genuine PARTIAL index' test below, per functional-test review -- a " +
      'non-partial index would ALSO produce correct results here, just by scanning more index ' +
      'entries, so this test alone cannot distinguish the two; it exists to prove correctness under ' +
      'a realistic mixed table, not index shape)',
    async () => {
      const { db, gmailAccountId } = await setup();
      // Interleaved deliberately (not a clean lexical block of 'completed-*' before 'active-*') so
      // this test cannot pass merely by accident of row/insertion order.
      for (let i = 0; i < 50; i++) {
        if (i === 17 || i === 33) {
          await seedInProgress(db, gmailAccountId, `active-${i}`, '2026-09-13T00:00:00.000Z');
          continue;
        }
        const messageId = `zz-completed-${i}`;
        const token = await seedInProgress(
          db,
          gmailAccountId,
          messageId,
          '2026-09-13T00:00:00.000Z',
        );
        await completeDelivery(db, { messageId, token, now: '2026-09-13T00:00:01.000Z' });
      }

      const recovered = await recoverStalePushDeliveries(db, {
        now: '2026-09-13T00:05:00.000Z',
        batchSize: 10,
        leaseDurationMs: LEASE_MS,
      });
      const ids = recovered.map((r) => r.messageId).sort();
      expect(ids).toEqual(['active-17', 'active-33']);
    },
  );

  it('EXPLAIN QUERY PLAN uses idx_gmail_push_deliveries_lease, not a full table scan', async () => {
    const { db } = await setup();
    const plan = await db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT message_id, gmail_account_id, start_history_id, lease_token
         FROM gmail_push_deliveries
         WHERE state = 'IN_PROGRESS' AND lease_expires_at <= ?
         ORDER BY lease_expires_at
         LIMIT ?`,
      )
      .bind(FIXTURE_NOW, 10)
      .all<{ detail: string }>();

    const detail = plan.results.map((row) => row.detail).join(' | ');
    expect(detail).toContain('idx_gmail_push_deliveries_lease');
    expect(detail).not.toMatch(/SCAN gmail_push_deliveries\b(?!.*USING)/);
  });

  it(
    "idx_gmail_push_deliveries_lease is a genuine PARTIAL index (WHERE state = 'IN_PROGRESS') -- " +
      'functional-test review finding: naming the index in a query plan does not by itself prove ' +
      'this, since SQLite would pick the same-named index to serve this query even if it were NOT ' +
      "partial. This asserts the index's own definition directly, the only check that actually " +
      'fails if the partial predicate is removed from the migration.',
    async () => {
      const { db } = await setup();
      const indexList = await db
        .prepare(`PRAGMA index_list('gmail_push_deliveries')`)
        .all<{ name: string; partial: number }>();
      const target = indexList.results.find(
        (row) => row.name === 'idx_gmail_push_deliveries_lease',
      );
      expect(target).toBeDefined();
      expect(target?.partial).toBe(1);

      const definition = await db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
        .bind('idx_gmail_push_deliveries_lease')
        .first<{ sql: string }>();
      expect(definition?.sql).toContain("WHERE state = 'IN_PROGRESS'");
    },
  );

  it('over-batch: never reclaims more than batchSize in one tick, remainder picked up next tick', async () => {
    const { db, gmailAccountId } = await setup();
    for (let i = 0; i < 5; i++) {
      await seedInProgress(db, gmailAccountId, `over-${i}`, '2026-09-13T00:00:00.000Z');
    }

    const firstTick = await recoverStalePushDeliveries(db, {
      now: '2026-09-13T00:05:00.000Z',
      batchSize: 3,
      leaseDurationMs: LEASE_MS,
    });
    expect(firstTick).toHaveLength(3);

    // The first tick's 3 rows were reclaimed with a fresh, forward-looking lease -- they are no
    // longer expired, so exactly the remaining 2 are picked up next.
    const secondTick = await recoverStalePushDeliveries(db, {
      now: '2026-09-13T00:05:00.000Z',
      batchSize: 3,
      leaseDurationMs: LEASE_MS,
    });
    expect(secondTick).toHaveLength(2);
  });
});
