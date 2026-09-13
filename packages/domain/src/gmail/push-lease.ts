/* global crypto */
import type { D1Database } from '@cloudflare/workers-types';

/**
 * The real fenced lease over `gmail_push_deliveries` (proposal §2.6, GPT-PM rounds 2-6): a fresh
 * `crypto.randomUUID()` token per claim/reclaim, CAS reclaim, heartbeat renewal -- never a one-way
 * permanent-reject nonce, which is the wrong primitive for Pub/Sub's own at-least-once delivery
 * (an unacknowledged/non-2xx push is redelivered with the SAME messageId; a permanent reject on
 * first sight would suppress the exact redelivery needed to recover from a mid-traversal crash).
 *
 * Every mutation fences on THREE conditions together, at the mutation itself, never cached from an
 * earlier SELECT: `state = 'IN_PROGRESS'`, the exact observed `lease_token`, and (for reclaim only)
 * a fresh `lease_expires_at <= now` re-check. This mirrors `ingest_events.processing_lease_token`'s
 * own documented discipline (migration 0001) and `packages/domain/src/transitions.ts`'s real fence
 * shape exactly -- GPT-PM round 4 found a token+expiry-only reclaim still vulnerable to a live
 * heartbeat race, and round 5 found token+expiry alone (without a fresh state check) still
 * vulnerable to a SELECT->completion->reclaim race. Both are closed here by fencing on all three at
 * once, matching G2's own `state = 'PROCESSING' AND ${fenceSql}` pattern for every one of its own
 * lease mutations.
 */

export interface ClaimOrInspectOptions {
  messageId: string;
  gmailAccountId: string;
  startHistoryId: string;
  now: string;
  leaseDurationMs: number;
}

export type ClaimOutcome =
  | { outcome: 'WON'; token: string }
  | { outcome: 'COMPLETED' }
  | { outcome: 'IN_PROGRESS_ACTIVE' }
  | { outcome: 'IN_PROGRESS_EXPIRED'; observedToken: string };

/**
 * The push handler's entry point: `INSERT ... ON CONFLICT (message_id) DO NOTHING`, then reads
 * back the row's actual state to decide which of the four proposal §2.6 branches applies. A caller
 * that gets `IN_PROGRESS_EXPIRED` must call `reclaimDelivery` with the returned `observedToken`
 * before proceeding -- winning the insert here does not by itself mean this attempt owns an
 * EXPIRED row it merely observed.
 */
export async function claimOrInspectDelivery(
  db: D1Database,
  opts: ClaimOrInspectOptions,
): Promise<ClaimOutcome> {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.parse(opts.now) + opts.leaseDurationMs).toISOString();

  const inserted = await db
    .prepare(
      `INSERT INTO gmail_push_deliveries
         (message_id, state, lease_token, leased_at, lease_expires_at, gmail_account_id, start_history_id)
       VALUES (?, 'IN_PROGRESS', ?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO NOTHING`,
    )
    .bind(opts.messageId, token, opts.now, expiresAt, opts.gmailAccountId, opts.startHistoryId)
    .run();

  if (inserted.meta.changes === 1) {
    return { outcome: 'WON', token };
  }

  const row = await db
    .prepare(
      `SELECT state, lease_token, lease_expires_at FROM gmail_push_deliveries WHERE message_id = ?`,
    )
    .bind(opts.messageId)
    .first<{ state: string; lease_token: string; lease_expires_at: string }>();

  if (row === null) {
    // The conflicting row existed at INSERT time but is gone by the time we read it back -- no
    // code path in this module ever deletes a row, so this would mean a defect elsewhere (e.g. a
    // future cleanup sweep racing an in-flight claim without its own fence). Fail loud rather than
    // silently treating an impossible state as a fresh win.
    throw new Error(
      `claimOrInspectDelivery: message_id=${opts.messageId} conflicted on insert but no row was found on read-back`,
    );
  }

  if (row.state === 'COMPLETED') {
    return { outcome: 'COMPLETED' };
  }

  const expired = Date.parse(row.lease_expires_at) <= Date.parse(opts.now);
  return expired
    ? { outcome: 'IN_PROGRESS_EXPIRED', observedToken: row.lease_token }
    : { outcome: 'IN_PROGRESS_ACTIVE' };
}

export interface ReclaimOptions {
  messageId: string;
  observedToken: string;
  now: string;
  leaseDurationMs: number;
}

export type ReclaimResult = { reclaimed: true; token: string } | { reclaimed: false };

/**
 * CAS-reclaim, fenced on all three current conditions at the mutation itself (state, the exact
 * token this caller observed, and a fresh expiry re-check) -- not values cached from the earlier
 * `claimOrInspectDelivery` SELECT. Zero rows affected means the row is no longer IN_PROGRESS
 * (already completed), a concurrent reclaimer won first, or the original claimant's heartbeat
 * renewed it after the caller's SELECT -- any of those, this attempt must not proceed.
 */
export async function reclaimDelivery(
  db: D1Database,
  opts: ReclaimOptions,
): Promise<ReclaimResult> {
  const newToken = crypto.randomUUID();
  const expiresAt = new Date(Date.parse(opts.now) + opts.leaseDurationMs).toISOString();

  const result = await db
    .prepare(
      `UPDATE gmail_push_deliveries
         SET lease_token = ?, leased_at = ?, lease_expires_at = ?
       WHERE message_id = ? AND state = 'IN_PROGRESS' AND lease_token = ? AND lease_expires_at <= ?`,
    )
    .bind(newToken, opts.now, expiresAt, opts.messageId, opts.observedToken, opts.now)
    .run();

  return result.meta.changes === 1 ? { reclaimed: true, token: newToken } : { reclaimed: false };
}

export interface DeliveryHeartbeatOptions {
  messageId: string;
  token: string;
  now: string;
  leaseDurationMs: number;
}

/**
 * Renews a held lease's expiry WITHOUT rotating its token, matching `renewLease`'s own documented
 * behavior for exactly the same reason: a token-rotating heartbeat would make every in-flight
 * traversal's own token stale on its own next mutation. Fenced on state + token together; a `false`
 * return means a sweep already reclaimed this lease (lost the race to this traversal having
 * stalled past its TTL) and the caller must stop further work rather than continue under a lease it
 * no longer holds -- this is the signal a live `GmailEventProcessor` cooperates with via
 * `leaseLost` for the enrichment write (see `packages/domain/src/gmail/enrichment.ts`).
 */
export async function renewDeliveryLease(
  db: D1Database,
  opts: DeliveryHeartbeatOptions,
): Promise<boolean> {
  const expiresAt = new Date(Date.parse(opts.now) + opts.leaseDurationMs).toISOString();
  const result = await db
    .prepare(
      `UPDATE gmail_push_deliveries SET lease_expires_at = ?
       WHERE message_id = ? AND state = 'IN_PROGRESS' AND lease_token = ?`,
    )
    .bind(expiresAt, opts.messageId, opts.token)
    .run();
  return result.meta.changes === 1;
}

export interface CompleteDeliveryOptions {
  messageId: string;
  token: string;
  now: string;
}

/**
 * Terminal transition: IN_PROGRESS -> COMPLETED, fenced on state + the exact held token. A
 * reclaimed/superseded attempt's late completion (its token no longer matches the row's current
 * one) affects zero rows -- exactly `completeProcessing`'s own ABA protection, applied to this
 * table.
 */
export async function completeDelivery(
  db: D1Database,
  opts: CompleteDeliveryOptions,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE gmail_push_deliveries SET state = 'COMPLETED', completed_at = ?
       WHERE message_id = ? AND state = 'IN_PROGRESS' AND lease_token = ?`,
    )
    .bind(opts.now, opts.messageId, opts.token)
    .run();
  return result.meta.changes === 1;
}

export interface PruneCompletedDeliveriesOptions {
  now: string;
  retentionMs: number;
}

/**
 * A `COMPLETED` row is retained only long enough to keep serving the replay-suppression check
 * (proposal §2.6) -- Pub/Sub can redeliver an already-handled message for as long as its own
 * retention/ack-deadline machinery allows, and `claimOrInspectDelivery` needs to see `COMPLETED`
 * (not a missing row, which would look like a fresh delivery) for exactly that long. `retentionMs`
 * is caller-supplied, not hardcoded here, matching `cleanupExpiredNonces`'s own
 * caller-supplied-window shape (`packages/domain/src/auth/nonce.ts`) -- the actual safe retention
 * period is a deployment/Pub/Sub-configuration concern, not a constant this module should assume.
 * Mirrors `cleanupExpiredNonces`'s shape: a plain bounded DELETE, no fencing needed (a COMPLETED
 * row is terminal -- nothing ever transitions it further, so there is no concurrent mutation to
 * race against a delete of an old one).
 */
export async function pruneCompletedPushDeliveries(
  db: D1Database,
  opts: PruneCompletedDeliveriesOptions,
): Promise<number> {
  const cutoff = new Date(Date.parse(opts.now) - opts.retentionMs).toISOString();
  const result = await db
    .prepare(`DELETE FROM gmail_push_deliveries WHERE state = 'COMPLETED' AND completed_at < ?`)
    .bind(cutoff)
    .run();
  return result.meta.changes;
}
