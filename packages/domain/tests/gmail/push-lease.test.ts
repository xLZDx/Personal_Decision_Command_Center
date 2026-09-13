import { describe, expect, it } from 'vitest';
import { createTestD1, loadG3Schema, seedBaselineAccounts, FIXTURE_NOW } from '@pdos/testkit';

import {
  claimOrInspectDelivery,
  reclaimDelivery,
  renewDeliveryLease,
  completeDelivery,
  pruneCompletedPushDeliveries,
} from '../../src/gmail/push-lease.js';

const LEASE_MS = 120_000;

async function setup() {
  const db = createTestD1(loadG3Schema());
  const accounts = await seedBaselineAccounts(db);
  return { db, gmailAccountId: accounts.gmailAccountId };
}

describe('claimOrInspectDelivery', () => {
  it('WON: a fresh message_id is claimed outright', async () => {
    const { db, gmailAccountId } = await setup();
    const result = await claimOrInspectDelivery(db, {
      messageId: 'm-1',
      gmailAccountId,
      startHistoryId: 'h-100',
      now: FIXTURE_NOW,
      leaseDurationMs: LEASE_MS,
    });
    expect(result.outcome).toBe('WON');
    const row = await db
      .prepare('SELECT state, lease_token FROM gmail_push_deliveries WHERE message_id = ?')
      .bind('m-1')
      .first<{ state: string; lease_token: string }>();
    expect(row?.state).toBe('IN_PROGRESS');
    if (result.outcome === 'WON') expect(row?.lease_token).toBe(result.token);
  });

  it('COMPLETED: a safe, finished replay -- no work, no reclaim attempted', async () => {
    const { db, gmailAccountId } = await setup();
    const first = await claimOrInspectDelivery(db, {
      messageId: 'm-2',
      gmailAccountId,
      startHistoryId: 'h-100',
      now: FIXTURE_NOW,
      leaseDurationMs: LEASE_MS,
    });
    expect(first.outcome).toBe('WON');
    if (first.outcome !== 'WON') throw new Error('unreachable');
    const completed = await completeDelivery(db, {
      messageId: 'm-2',
      token: first.token,
      now: FIXTURE_NOW,
    });
    expect(completed).toBe(true);

    const replay = await claimOrInspectDelivery(db, {
      messageId: 'm-2',
      gmailAccountId,
      startHistoryId: 'h-999',
      now: FIXTURE_NOW,
      leaseDurationMs: LEASE_MS,
    });
    expect(replay.outcome).toBe('COMPLETED');
  });

  it('IN_PROGRESS_ACTIVE: a concurrent live delivery is not ACKed away (round-3 BLOCKER)', async () => {
    const { db, gmailAccountId } = await setup();
    await claimOrInspectDelivery(db, {
      messageId: 'm-3',
      gmailAccountId,
      startHistoryId: 'h-100',
      now: FIXTURE_NOW,
      leaseDurationMs: LEASE_MS,
    });
    const dup = await claimOrInspectDelivery(db, {
      messageId: 'm-3',
      gmailAccountId,
      startHistoryId: 'h-100',
      now: FIXTURE_NOW,
      leaseDurationMs: LEASE_MS,
    });
    expect(dup.outcome).toBe('IN_PROGRESS_ACTIVE');
  });

  it('IN_PROGRESS_EXPIRED: reports the observed token for the caller to attempt reclaim', async () => {
    const { db, gmailAccountId } = await setup();
    const claimTime = '2026-09-13T00:00:00.000Z';
    const later = '2026-09-13T00:05:00.000Z'; // past claimTime + LEASE_MS
    const first = await claimOrInspectDelivery(db, {
      messageId: 'm-4',
      gmailAccountId,
      startHistoryId: 'h-100',
      now: claimTime,
      leaseDurationMs: LEASE_MS,
    });
    expect(first.outcome).toBe('WON');
    if (first.outcome !== 'WON') throw new Error('unreachable');

    const stale = await claimOrInspectDelivery(db, {
      messageId: 'm-4',
      gmailAccountId,
      startHistoryId: 'h-100',
      now: later,
      leaseDurationMs: LEASE_MS,
    });
    expect(stale).toEqual({ outcome: 'IN_PROGRESS_EXPIRED', observedToken: first.token });
  });
});

describe('reclaimDelivery', () => {
  it('succeeds against a genuinely expired lease, rotating the token', async () => {
    const { db, gmailAccountId } = await setup();
    const claimTime = '2026-09-13T00:00:00.000Z';
    const later = '2026-09-13T00:05:00.000Z';
    const first = await claimOrInspectDelivery(db, {
      messageId: 'm-5',
      gmailAccountId,
      startHistoryId: 'h-100',
      now: claimTime,
      leaseDurationMs: LEASE_MS,
    });
    if (first.outcome !== 'WON') throw new Error('unreachable');

    const reclaim = await reclaimDelivery(db, {
      messageId: 'm-5',
      observedToken: first.token,
      now: later,
      leaseDurationMs: LEASE_MS,
    });
    expect(reclaim.reclaimed).toBe(true);
    if (!reclaim.reclaimed) throw new Error('unreachable');
    expect(reclaim.token).not.toBe(first.token);

    const row = await db
      .prepare('SELECT lease_token FROM gmail_push_deliveries WHERE message_id = ?')
      .bind('m-5')
      .first<{ lease_token: string }>();
    expect(row?.lease_token).toBe(reclaim.token);
  });

  it(
    'round-4 MAJOR regression: a live heartbeat between an earlier read and this reclaim ' +
      'attempt must win -- token+expiry-only fencing is not enough',
    async () => {
      const { db, gmailAccountId } = await setup();
      const claimTime = '2026-09-13T00:00:00.000Z';
      const observedAt = '2026-09-13T00:05:00.000Z'; // lease looks expired at this instant
      const first = await claimOrInspectDelivery(db, {
        messageId: 'm-6',
        gmailAccountId,
        startHistoryId: 'h-100',
        now: claimTime,
        leaseDurationMs: LEASE_MS,
      });
      if (first.outcome !== 'WON') throw new Error('unreachable');

      const stale = await claimOrInspectDelivery(db, {
        messageId: 'm-6',
        gmailAccountId,
        startHistoryId: 'h-100',
        now: observedAt,
        leaseDurationMs: LEASE_MS,
      });
      expect(stale.outcome).toBe('IN_PROGRESS_EXPIRED');

      // The live holder heartbeats right after the SELECT above landed, extending expiry into the
      // future while retaining the SAME token -- exactly the documented "renew without rotating"
      // behavior a token-only fence would miss.
      const renewed = await renewDeliveryLease(db, {
        messageId: 'm-6',
        token: first.token,
        now: observedAt,
        leaseDurationMs: LEASE_MS,
      });
      expect(renewed).toBe(true);

      const reclaimAttempt = await reclaimDelivery(db, {
        messageId: 'm-6',
        observedToken: first.token,
        now: observedAt,
        leaseDurationMs: LEASE_MS,
      });
      expect(reclaimAttempt.reclaimed).toBe(false);

      const row = await db
        .prepare('SELECT state, lease_token FROM gmail_push_deliveries WHERE message_id = ?')
        .bind('m-6')
        .first<{ state: string; lease_token: string }>();
      expect(row).toEqual({ state: 'IN_PROGRESS', lease_token: first.token });
    },
  );

  it(
    'round-5 MAJOR regression: a completion between an earlier read and this reclaim ' +
      'attempt must win -- token+expiry fencing without a fresh state check is not enough',
    async () => {
      const { db, gmailAccountId } = await setup();
      const claimTime = '2026-09-13T00:00:00.000Z';
      const observedAt = '2026-09-13T00:05:00.000Z';
      const first = await claimOrInspectDelivery(db, {
        messageId: 'm-7',
        gmailAccountId,
        startHistoryId: 'h-100',
        now: claimTime,
        leaseDurationMs: LEASE_MS,
      });
      if (first.outcome !== 'WON') throw new Error('unreachable');

      const stale = await claimOrInspectDelivery(db, {
        messageId: 'm-7',
        gmailAccountId,
        startHistoryId: 'h-100',
        now: observedAt,
        leaseDurationMs: LEASE_MS,
      });
      expect(stale.outcome).toBe('IN_PROGRESS_EXPIRED');

      // The original handler legitimately completes right after the SELECT above landed -- the
      // row is now COMPLETED, still carrying the same (now-stale-looking) token and expiry.
      const completed = await completeDelivery(db, {
        messageId: 'm-7',
        token: first.token,
        now: observedAt,
      });
      expect(completed).toBe(true);

      const reclaimAttempt = await reclaimDelivery(db, {
        messageId: 'm-7',
        observedToken: first.token,
        now: observedAt,
        leaseDurationMs: LEASE_MS,
      });
      expect(reclaimAttempt.reclaimed).toBe(false);

      const row = await db
        .prepare('SELECT state FROM gmail_push_deliveries WHERE message_id = ?')
        .bind('m-7')
        .first<{ state: string }>();
      expect(row?.state).toBe('COMPLETED');
    },
  );

  it('round-3 MAJOR regression: two concurrent reclaimers racing the same expired row -- exactly one wins', async () => {
    const { db, gmailAccountId } = await setup();
    const claimTime = '2026-09-13T00:00:00.000Z';
    const later = '2026-09-13T00:05:00.000Z';
    const first = await claimOrInspectDelivery(db, {
      messageId: 'm-8',
      gmailAccountId,
      startHistoryId: 'h-100',
      now: claimTime,
      leaseDurationMs: LEASE_MS,
    });
    if (first.outcome !== 'WON') throw new Error('unreachable');

    const [a, b] = await Promise.all([
      reclaimDelivery(db, {
        messageId: 'm-8',
        observedToken: first.token,
        now: later,
        leaseDurationMs: LEASE_MS,
      }),
      reclaimDelivery(db, {
        messageId: 'm-8',
        observedToken: first.token,
        now: later,
        leaseDurationMs: LEASE_MS,
      }),
    ]);
    const wins = [a, b].filter((r) => r.reclaimed).length;
    expect(wins).toBe(1);
    const loser = a.reclaimed ? b : a;
    if (loser.reclaimed) throw new Error('unreachable: exactly one winner expected');
    // The loser's own token was never rotated -- see the dedicated ABA-protection test below
    // ('a reclaimed/superseded attempt late-completing under its old token affects zero rows')
    // for the corresponding stale-completion check.
  });

  it('does not reclaim a lease that is not actually expired', async () => {
    const { db, gmailAccountId } = await setup();
    const claimTime = '2026-09-13T00:00:00.000Z';
    const first = await claimOrInspectDelivery(db, {
      messageId: 'm-9',
      gmailAccountId,
      startHistoryId: 'h-100',
      now: claimTime,
      leaseDurationMs: LEASE_MS,
    });
    if (first.outcome !== 'WON') throw new Error('unreachable');

    const reclaim = await reclaimDelivery(db, {
      messageId: 'm-9',
      observedToken: first.token,
      now: claimTime, // still well within the lease
      leaseDurationMs: LEASE_MS,
    });
    expect(reclaim.reclaimed).toBe(false);
  });
});

describe('completeDelivery / renewDeliveryLease ABA protection', () => {
  it('a reclaimed/superseded attempt late-completing under its old token affects zero rows', async () => {
    const { db, gmailAccountId } = await setup();
    const claimTime = '2026-09-13T00:00:00.000Z';
    const later = '2026-09-13T00:05:00.000Z';
    const first = await claimOrInspectDelivery(db, {
      messageId: 'm-10',
      gmailAccountId,
      startHistoryId: 'h-100',
      now: claimTime,
      leaseDurationMs: LEASE_MS,
    });
    if (first.outcome !== 'WON') throw new Error('unreachable');

    const reclaim = await reclaimDelivery(db, {
      messageId: 'm-10',
      observedToken: first.token,
      now: later,
      leaseDurationMs: LEASE_MS,
    });
    expect(reclaim.reclaimed).toBe(true);

    const staleComplete = await completeDelivery(db, {
      messageId: 'm-10',
      token: first.token, // the ORIGINAL, now-superseded token
      now: later,
    });
    expect(staleComplete).toBe(false);

    const row = await db
      .prepare('SELECT state FROM gmail_push_deliveries WHERE message_id = ?')
      .bind('m-10')
      .first<{ state: string }>();
    expect(row?.state).toBe('IN_PROGRESS');
  });

  it('a reclaimed/superseded attempt heartbeating under its old token affects zero rows', async () => {
    const { db, gmailAccountId } = await setup();
    const claimTime = '2026-09-13T00:00:00.000Z';
    const later = '2026-09-13T00:05:00.000Z';
    const first = await claimOrInspectDelivery(db, {
      messageId: 'm-11',
      gmailAccountId,
      startHistoryId: 'h-100',
      now: claimTime,
      leaseDurationMs: LEASE_MS,
    });
    if (first.outcome !== 'WON') throw new Error('unreachable');

    await reclaimDelivery(db, {
      messageId: 'm-11',
      observedToken: first.token,
      now: later,
      leaseDurationMs: LEASE_MS,
    });

    const staleHeartbeat = await renewDeliveryLease(db, {
      messageId: 'm-11',
      token: first.token,
      now: later,
      leaseDurationMs: LEASE_MS,
    });
    expect(staleHeartbeat).toBe(false);
  });
});

describe('pruneCompletedPushDeliveries', () => {
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  it('deletes a COMPLETED row past the retention window', async () => {
    const { db, gmailAccountId } = await setup();
    const first = await claimOrInspectDelivery(db, {
      messageId: 'm-old',
      gmailAccountId,
      startHistoryId: 'h-100',
      now: '2026-09-01T00:00:00.000Z',
      leaseDurationMs: LEASE_MS,
    });
    if (first.outcome !== 'WON') throw new Error('unreachable');
    await completeDelivery(db, {
      messageId: 'm-old',
      token: first.token,
      now: '2026-09-01T00:00:00.000Z',
    });

    const deleted = await pruneCompletedPushDeliveries(db, {
      now: '2026-09-13T00:00:00.000Z', // 12 days later, past the 7-day retention window
      retentionMs: RETENTION_MS,
    });
    expect(deleted).toBe(1);

    const row = await db
      .prepare('SELECT 1 FROM gmail_push_deliveries WHERE message_id = ?')
      .bind('m-old')
      .first();
    expect(row).toBeNull();
  });

  it('does not delete a COMPLETED row still inside the retention window', async () => {
    const { db, gmailAccountId } = await setup();
    const first = await claimOrInspectDelivery(db, {
      messageId: 'm-recent',
      gmailAccountId,
      startHistoryId: 'h-100',
      now: '2026-09-12T00:00:00.000Z',
      leaseDurationMs: LEASE_MS,
    });
    if (first.outcome !== 'WON') throw new Error('unreachable');
    await completeDelivery(db, {
      messageId: 'm-recent',
      token: first.token,
      now: '2026-09-12T00:00:00.000Z',
    });

    const deleted = await pruneCompletedPushDeliveries(db, {
      now: '2026-09-13T00:00:00.000Z', // 1 day later, well inside the 7-day retention window
      retentionMs: RETENTION_MS,
    });
    expect(deleted).toBe(0);

    const row = await db
      .prepare('SELECT 1 FROM gmail_push_deliveries WHERE message_id = ?')
      .bind('m-recent')
      .first();
    expect(row).not.toBeNull();
  });

  it('never deletes an IN_PROGRESS row, no matter how old', async () => {
    const { db, gmailAccountId } = await setup();
    await claimOrInspectDelivery(db, {
      messageId: 'm-stuck',
      gmailAccountId,
      startHistoryId: 'h-100',
      now: '2026-01-01T00:00:00.000Z',
      leaseDurationMs: LEASE_MS,
    });

    const deleted = await pruneCompletedPushDeliveries(db, {
      now: '2026-09-13T00:00:00.000Z',
      retentionMs: RETENTION_MS,
    });
    expect(deleted).toBe(0);

    const row = await db
      .prepare('SELECT 1 FROM gmail_push_deliveries WHERE message_id = ?')
      .bind('m-stuck')
      .first();
    expect(row).not.toBeNull();
  });
});
