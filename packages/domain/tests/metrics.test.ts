import { describe, expect, it } from 'vitest';
import { createTestD1, loadG2Schema, seedBaselineAccounts, seedEvent } from '@pdos/testkit';

import { getOldestUnprocessedEvent } from '../src/metrics.js';

describe('getOldestUnprocessedEvent', () => {
  it('returns null when nothing is accepted-unprocessed', async () => {
    const db = createTestD1(loadG2Schema());
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, { eventId: 'ev-done', state: 'PROCESSED' });
    await seedEvent(db, accounts, { eventId: 'ev-dlq', state: 'DLQ', attemptCount: 1 });

    expect(await getOldestUnprocessedEvent(db, { now: '2026-09-13T00:10:00.000Z' })).toBeNull();
  });

  it('finds the oldest by received_at across ACCEPTED, PROCESSING, and RETRYABLE_FAILED, ignoring terminal states', async () => {
    const db = createTestD1(loadG2Schema());
    const accounts = await seedBaselineAccounts(db);
    // seedEvent fixes received_at at FIXTURE_NOW for every row, so distinguish "oldest" via a
    // direct UPDATE after seeding -- the function under test only reads received_at, not insertion
    // order, and this proves that rather than assuming it.
    await seedEvent(db, accounts, { eventId: 'ev-newer', state: 'ACCEPTED' });
    await seedEvent(db, accounts, { eventId: 'ev-oldest', state: 'RETRYABLE_FAILED' });
    await seedEvent(db, accounts, { eventId: 'ev-terminal-but-old', state: 'PROCESSED' });
    await db
      .prepare('UPDATE ingest_events SET received_at = ? WHERE event_id = ?')
      .bind('2026-09-12T00:00:00.000Z', 'ev-oldest')
      .run();
    await db
      .prepare('UPDATE ingest_events SET received_at = ? WHERE event_id = ?')
      .bind('2026-09-01T00:00:00.000Z', 'ev-terminal-but-old')
      .run();

    const result = await getOldestUnprocessedEvent(db, { now: '2026-09-13T00:00:00.000Z' });
    expect(result?.eventId).toBe('ev-oldest');
    expect(result?.receivedAt).toBe('2026-09-12T00:00:00.000Z');
    // 2026-09-13T00:00:00Z - 2026-09-12T00:00:00Z = 24h.
    expect(result?.ageMs).toBe(24 * 60 * 60 * 1000);
  });
});
