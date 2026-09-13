import type { D1Database } from '@cloudflare/workers-types';

export interface SigningKeyLookupOptions {
  connectorId: string;
  keyVersion: string;
  now: string;
}

export type SigningKeyStatus = 'VALID' | 'UNKNOWN' | 'REVOKED' | 'NOT_YET_VALID' | 'EXPIRED';

/**
 * Metadata-only lookup: `ingest_signing_keys` never holds secret bytes (migration 0001's own
 * comment) -- this only says WHICH (connector, key version) pairs are currently valid, so an
 * unknown or revoked key version is rejected before any secret lookup (a Worker Secret binding
 * access) is even attempted.
 */
export async function lookupSigningKeyStatus(
  db: D1Database,
  opts: SigningKeyLookupOptions,
): Promise<SigningKeyStatus> {
  const row = await db
    .prepare(
      'SELECT status, valid_from, valid_until FROM ingest_signing_keys WHERE connector_id = ? AND key_version = ?',
    )
    .bind(opts.connectorId, opts.keyVersion)
    .first<{ status: 'ACTIVE' | 'REVOKED'; valid_from: string; valid_until: string | null }>();

  if (!row) return 'UNKNOWN';
  if (row.status === 'REVOKED') return 'REVOKED';

  // Security fix (G2 gate review MAJOR): `valid_from`/`valid_until` are unconstrained TEXT in D1
  // (metadata this table stores, never validated against a schema before this function reads it --
  // provisioning tooling or a corrupted row could write anything). `Date.parse` on a genuinely
  // malformed value returns NaN, and NaN fails EVERY comparison (`<`/`>`), so both guards below
  // would silently fall through to VALID for a key whose validity window can no longer be
  // evaluated at all -- fail OPEN on exactly the data a fail-CLOSED check exists to police. Treated
  // as UNKNOWN (never trust an unparseable validity window), the same outcome as a key that does
  // not exist -- both mean "cannot be verified as currently valid."
  const validFromMs = Date.parse(row.valid_from);
  if (Number.isNaN(validFromMs)) return 'UNKNOWN';
  const nowMs = Date.parse(opts.now);
  if (nowMs < validFromMs) return 'NOT_YET_VALID';

  if (row.valid_until !== null) {
    const validUntilMs = Date.parse(row.valid_until);
    if (Number.isNaN(validUntilMs)) return 'UNKNOWN';
    if (nowMs > validUntilMs) return 'EXPIRED';
  }

  return 'VALID';
}
