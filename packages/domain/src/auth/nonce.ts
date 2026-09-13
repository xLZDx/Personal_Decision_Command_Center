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
 */
export async function cleanupExpiredNonces(
  db: D1Database,
  opts: { now: string; windowMs: number },
): Promise<number> {
  const cutoff = new Date(Date.parse(opts.now) - opts.windowMs).toISOString();
  const result = await db
    .prepare('DELETE FROM ingest_nonces WHERE reserved_at < ?')
    .bind(cutoff)
    .run();
  return result.meta.changes;
}
