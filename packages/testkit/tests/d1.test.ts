import { describe, expect, it } from 'vitest';

import { createTestD1 } from '../src/d1.js';
import { loadG2Schema } from '../src/schema.js';
import { seedBaselineAccounts, seedEvent } from '../src/fixtures.js';

describe('createTestD1', () => {
  it('applies the real G2 schema without error', () => {
    expect(() => createTestD1(loadG2Schema())).not.toThrow();
  });

  it('enforces foreign keys (D1-confirmed default behavior)', async () => {
    const db = createTestD1(loadG2Schema());
    await expect(
      db
        .prepare(
          'INSERT INTO source_accounts (source_account_id, user_id, source, created_at, updated_at) VALUES (?,?,?,?,?)',
        )
        .bind('acc-orphan', 'no-such-user', 'gmail', 'now', 'now')
        .run(),
    ).rejects.toThrow();
  });

  it('.run() reports meta.changes for an ordinary UPDATE', async () => {
    const db = createTestD1(loadG2Schema());
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, { eventId: 'ev-1' });

    const result = await db
      .prepare(
        "UPDATE ingest_events SET state = 'PROCESSED' WHERE event_id = ? AND state = 'ACCEPTED'",
      )
      .bind('ev-1')
      .run();
    expect(result.meta.changes).toBe(1);

    const noop = await db
      .prepare(
        "UPDATE ingest_events SET state = 'PROCESSED' WHERE event_id = ? AND state = 'ACCEPTED'",
      )
      .bind('ev-1')
      .run();
    expect(noop.meta.changes).toBe(0);
  });

  it('a RETURNING statement executes exactly once and reports its rows via .run()', async () => {
    const db = createTestD1(loadG2Schema());
    const first = await db
      .prepare(
        `INSERT INTO queue_budget_counters (day, dispatched_count) VALUES (?, 1)
         ON CONFLICT(day) DO UPDATE SET dispatched_count = dispatched_count + 1 WHERE dispatched_count < ?
         RETURNING dispatched_count`,
      )
      .bind('2026-09-13', 3)
      .run<{ dispatched_count: number }>();
    expect(first.results).toEqual([{ dispatched_count: 1 }]);

    const row = await db
      .prepare('SELECT dispatched_count FROM queue_budget_counters WHERE day = ?')
      .bind('2026-09-13')
      .first<{ dispatched_count: number }>();
    // Exactly-once execution proof: if .run() had ALSO executed via a plain .run() path (double
    // effect), this would read 2, not 1.
    expect(row?.dispatched_count).toBe(1);
  });

  it('batch() commits all statements atomically', async () => {
    const db = createTestD1(loadG2Schema());
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, { eventId: 'ev-batch' });

    await db.batch([
      db
        .prepare("UPDATE ingest_events SET state = 'PROCESSED' WHERE event_id = ?")
        .bind('ev-batch'),
      db
        .prepare(
          'INSERT INTO processing_outbox (event_id, state, dispatch_count, next_attempt_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind('ev-batch', 'CLOSED', 1, '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z'),
    ]);

    const event = await db
      .prepare('SELECT state FROM ingest_events WHERE event_id = ?')
      .bind('ev-batch')
      .first<{ state: string }>();
    const outbox = await db
      .prepare('SELECT state FROM processing_outbox WHERE event_id = ?')
      .bind('ev-batch')
      .first<{ state: string }>();
    expect(event?.state).toBe('PROCESSED');
    expect(outbox?.state).toBe('CLOSED');
  });

  it('batch() rolls back every statement when one of them fails', async () => {
    const db = createTestD1(loadG2Schema());
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, { eventId: 'ev-batch-fail' });

    await expect(
      db.batch([
        db
          .prepare("UPDATE ingest_events SET state = 'PROCESSED' WHERE event_id = ?")
          .bind('ev-batch-fail'),
        // Violates the FK on source_account_id/source -- the whole batch must roll back, including
        // the first statement's otherwise-valid UPDATE.
        db
          .prepare(
            'INSERT INTO processing_outbox (event_id, state, dispatch_count, next_attempt_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          )
          .bind(
            'event-that-does-not-exist',
            'CLOSED',
            1,
            '2026-09-13T00:00:00.000Z',
            '2026-09-13T00:00:00.000Z',
          ),
      ]),
    ).rejects.toThrow();

    const event = await db
      .prepare('SELECT state FROM ingest_events WHERE event_id = ?')
      .bind('ev-batch-fail')
      .first<{ state: string }>();
    expect(event?.state).toBe('ACCEPTED');
  });
});
