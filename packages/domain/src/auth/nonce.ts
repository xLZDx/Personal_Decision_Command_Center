import type { D1Database } from '@cloudflare/workers-types';

export interface ReserveNonceOptions {
  connectorId: string;
  keyVersion: string;
  nonce: string;
  now: string;
}

/**
 * Atomic replay defense: `INSERT ... ON CONFLICT DO NOTHING` against `ingest_nonces`'s own PRIMARY
 * KEY (connector_id, key_version, nonce). Zero rows affected means the triple was already seen --
 * the request is rejected as a replay, not retried or merged.
 */
export async function reserveNonce(db: D1Database, opts: ReserveNonceOptions): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO ingest_nonces (connector_id, key_version, nonce, reserved_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (connector_id, key_version, nonce) DO NOTHING`,
    )
    .bind(opts.connectorId, opts.keyVersion, opts.nonce, opts.now)
    .run();
  return result.meta.changes === 1;
}

/**
 * A nonce is only safe to purge once it has fallen outside the SAME accepted timestamp window the
 * signature check itself uses (migration 0001's own comment) -- purging on any other schedule
 * could let a nonce inside the still-accepted window be forgotten and hence replayable again.
 *
 * Security fix (G2 gate review MAJOR): `isTimestampWithinWindow` accepts `abs(now - signedTimestamp)
 * <= windowMs` -- SYMMETRIC, so a request signed with a timestamp up to `windowMs` ahead of
 * server-now (future clock skew, explicitly tolerated) stays acceptable until server-now exceeds
 * `signedTimestamp + windowMs`, i.e. up to `2*windowMs` after the moment this nonce was reserved in
 * the worst case. Purging at a single `windowMs` (as this function originally did) opens a replay
 * window between `windowMs` and `2*windowMs` after reservation: the row is gone (so `reserveNonce`
 * would accept a replay of the same triple again) while the ORIGINAL signed request could still be
 * within its own accepted timestamp window. Retaining for the full `2*windowMs` possible acceptance
 * interval closes that gap without a schema change (no per-nonce signed-timestamp column needed).
 */
export async function cleanupExpiredNonces(
  db: D1Database,
  opts: { now: string; windowMs: number },
): Promise<number> {
  const cutoff = new Date(Date.parse(opts.now) - 2 * opts.windowMs).toISOString();
  const result = await db
    .prepare('DELETE FROM ingest_nonces WHERE reserved_at < ?')
    .bind(cutoff)
    .run();
  return result.meta.changes;
}
