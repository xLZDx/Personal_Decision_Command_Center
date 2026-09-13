import type { D1Database } from '@cloudflare/workers-types';

import { isTimestampWithinWindow, verifyHmacSignature } from './hmac.js';
import { lookupSigningKeyStatus } from './keys.js';
import { reserveNonce } from './nonce.js';

export interface AuthenticateIngestRequestOptions {
  connectorId: string;
  keyVersion: string;
  /** Resolved from a Cloudflare Worker Secret binding by the caller, keyed by
   *  (connectorId, keyVersion) -- this boundary never reads or stores the secret itself. */
  secret: string;
  timestamp: string;
  nonce: string;
  signatureHex: string;
  /** The exact canonical string the connector signed -- see `canonicalSigningPayload`. */
  payload: string;
  now: string;
  timestampWindowMs: number;
}

export type AuthenticateIngestRequestResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'UNKNOWN_KEY'
        | 'REVOKED_KEY'
        | 'KEY_NOT_YET_VALID'
        | 'KEY_EXPIRED'
        | 'TIMESTAMP_OUT_OF_WINDOW'
        | 'BAD_SIGNATURE'
        | 'REPLAYED_NONCE';
    };

/**
 * The generic HMAC ingest-authentication boundary (TDD's "authenticate + validate + dedupe -> D1"
 * contract), connector-neutral. Order is deliberate and load-bearing: key validity and the
 * timestamp window are checked first (cheap, no DB write); the signature is verified next (proves
 * authenticity without consuming anything); the nonce is reserved LAST, only once the request has
 * already proven genuine -- reserving it earlier would let an attacker who merely observed a
 * legitimate request's cleartext timestamp+nonce (attached to a garbage signature) burn that nonce
 * ahead of the real sender, turning a no-op forgery attempt into a denial of service against the
 * genuine request.
 */
export async function authenticateIngestRequest(
  db: D1Database,
  opts: AuthenticateIngestRequestOptions,
): Promise<AuthenticateIngestRequestResult> {
  const keyStatus = await lookupSigningKeyStatus(db, {
    connectorId: opts.connectorId,
    keyVersion: opts.keyVersion,
    now: opts.now,
  });
  if (keyStatus === 'UNKNOWN') return { ok: false, reason: 'UNKNOWN_KEY' };
  if (keyStatus === 'REVOKED') return { ok: false, reason: 'REVOKED_KEY' };
  if (keyStatus === 'NOT_YET_VALID') return { ok: false, reason: 'KEY_NOT_YET_VALID' };
  if (keyStatus === 'EXPIRED') return { ok: false, reason: 'KEY_EXPIRED' };

  if (!isTimestampWithinWindow(opts.timestamp, opts.now, opts.timestampWindowMs)) {
    return { ok: false, reason: 'TIMESTAMP_OUT_OF_WINDOW' };
  }

  const validSignature = await verifyHmacSignature(opts.secret, opts.payload, opts.signatureHex);
  if (!validSignature) return { ok: false, reason: 'BAD_SIGNATURE' };

  const reserved = await reserveNonce(db, {
    connectorId: opts.connectorId,
    keyVersion: opts.keyVersion,
    nonce: opts.nonce,
    now: opts.now,
  });
  if (!reserved) return { ok: false, reason: 'REPLAYED_NONCE' };

  return { ok: true };
}
