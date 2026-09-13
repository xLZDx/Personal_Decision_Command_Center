import type { D1Database } from '@cloudflare/workers-types';

import { reclaimDelivery } from './push-lease.js';

/**
 * The independent scheduled recovery sweep (proposal §2.6): resumes a stuck `gmail_push_deliveries`
 * row with no dependency on a future Gmail-side event or a fresh Pub/Sub redelivery -- closing the
 * "ACKed duplicate + then the winner crashes = permanently stuck" gap GPT-PM's round-3 BLOCKER
 * named (a non-2xx response to a live duplicate is not by itself a full fix: it only causes Pub/Sub
 * to retry, and Pub/Sub has no reason to retry once *some* response was 2xx'd for the message).
 *
 * Bounded and indexed exactly like `recoverStaleLeases` (`packages/domain/src/lease-recovery.ts`):
 * an explicit `LIMIT` and `ORDER BY lease_expires_at`, backed by `idx_gmail_push_deliveries_lease`'s
 * partial index (`WHERE state = 'IN_PROGRESS'`, migration 0002) -- never an unbounded scan over
 * retained COMPLETED rows.
 */

export interface RecoverStalePushDeliveriesOptions {
  now: string;
  batchSize: number;
  /** The real, forward-looking lease duration granted to a successfully reclaimed row -- same
   *  duration the live push handler itself uses, so the resuming traversal has genuine working
   *  time before it must heartbeat, rather than an immediately-re-expired lease other concurrent
   *  claimants could thrash against. */
  leaseDurationMs: number;
}

export interface RecoveredPushDelivery {
  messageId: string;
  gmailAccountId: string;
  startHistoryId: string;
  outcome: 'RECLAIMED' | 'RACE_LOST';
  /** Present only when `outcome === 'RECLAIMED'` -- the fresh token this sweep attempt now holds. */
  token?: string;
}

export async function recoverStalePushDeliveries(
  db: D1Database,
  opts: RecoverStalePushDeliveriesOptions,
): Promise<RecoveredPushDelivery[]> {
  const candidates = await db
    .prepare(
      `SELECT message_id, gmail_account_id, start_history_id, lease_token
       FROM gmail_push_deliveries
       WHERE state = 'IN_PROGRESS' AND lease_expires_at <= ?
       ORDER BY lease_expires_at
       LIMIT ?`,
    )
    .bind(opts.now, opts.batchSize)
    .all<{
      message_id: string;
      gmail_account_id: string;
      start_history_id: string;
      lease_token: string;
    }>();

  const recovered: RecoveredPushDelivery[] = [];
  for (const row of candidates.results) {
    const result = await reclaimDelivery(db, {
      messageId: row.message_id,
      observedToken: row.lease_token,
      now: opts.now,
      leaseDurationMs: opts.leaseDurationMs,
    });
    recovered.push(
      result.reclaimed
        ? {
            messageId: row.message_id,
            gmailAccountId: row.gmail_account_id,
            startHistoryId: row.start_history_id,
            outcome: 'RECLAIMED',
            token: result.token,
          }
        : {
            messageId: row.message_id,
            gmailAccountId: row.gmail_account_id,
            startHistoryId: row.start_history_id,
            outcome: 'RACE_LOST',
          },
    );
  }
  return recovered;
}
