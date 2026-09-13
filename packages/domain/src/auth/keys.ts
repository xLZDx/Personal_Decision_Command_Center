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
  if (Date.parse(opts.now) < Date.parse(row.valid_from)) return 'NOT_YET_VALID';
  if (row.valid_until !== null && Date.parse(opts.now) > Date.parse(row.valid_until)) {
    return 'EXPIRED';
  }
  return 'VALID';
}
