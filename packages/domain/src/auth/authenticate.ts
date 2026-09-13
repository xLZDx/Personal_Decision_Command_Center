import type { D1Database } from '@cloudflare/workers-types';

import { isTimestampWithinWindow, verifyHmacSignature } from './hmac.js';
import { lookupSigningKeyStatus } from './keys.js';
import { reserveNonce } from './nonce.js';

export type AuthenticateIngestRequestReason =
  | 'UNKNOWN_KEY'
  | 'REVOKED_KEY'
  | 'KEY_NOT_YET_VALID'
  | 'KEY_EXPIRED'
  | 'TIMESTAMP_OUT_OF_WINDOW'
  | 'BAD_SIGNATURE'
  | 'REPLAYED_NONCE';

export type AuthenticateIngestRequestResult =
  { ok: true } | { ok: false; reason: AuthenticateIngestRequestReason };

export interface CheckKeyAndTimestampOptions {
  connectorId: string;
  keyVersion: string;
  timestamp: string;
  now: string;
  timestampWindowMs: number;
}

/**
 * The cheap half of the HMAC ingest-authentication boundary: key validity and the timestamp
 * window, both checkable from header/metadata alone -- no request body needed. Split out
 * (security fix, G2 gate review MAJOR) so a caller can reject an unauthenticated request BEFORE
 * ever reading/buffering/hashing its body: an oversized body from a caller presenting syntactically
 * valid but bogus auth headers must never cost the Worker CPU/memory that only the FULL check
 * (including the body-dependent signature) can prove was worth spending.
 */
export async function checkKeyAndTimestamp(
  db: D1Database,
  opts: CheckKeyAndTimestampOptions,
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

  return { ok: true };
}

export interface CheckSignatureAndNonceOptions {
  connectorId: string;
  keyVersion: string;
  /** Resolved from a Cloudflare Worker Secret binding by the caller, keyed by
   *  (connectorId, keyVersion) -- this boundary never reads or stores the secret itself. */
  secret: string;
  nonce: string;
  signatureHex: string;
  /** The exact canonical string the connector signed -- see `canonicalSigningPayload`. */
  payload: string;
  now: string;
}

/**
 * The body-dependent half: signature verification, then nonce reservation LAST -- only once the
 * request has already proven genuine, never earlier. Reserving the nonce first would let an
 * attacker who merely observed a legitimate request's cleartext timestamp+nonce (attached to a
 * garbage signature) burn that nonce ahead of the real sender, turning a no-op forgery attempt into
 * a denial of service against the genuine request.
 */
export async function checkSignatureAndNonce(
  db: D1Database,
  opts: CheckSignatureAndNonceOptions,
): Promise<AuthenticateIngestRequestResult> {
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

export interface AuthenticateIngestRequestOptions
  extends CheckKeyAndTimestampOptions, CheckSignatureAndNonceOptions {}

/**
 * The generic HMAC ingest-authentication boundary (TDD's "authenticate + validate + dedupe -> D1"
 * contract), connector-neutral -- composes `checkKeyAndTimestamp` then `checkSignatureAndNonce` in
 * that order for a caller that does not need the two-phase (pre-body/post-body) split above.
 */
export async function authenticateIngestRequest(
  db: D1Database,
  opts: AuthenticateIngestRequestOptions,
): Promise<AuthenticateIngestRequestResult> {
  const preBody = await checkKeyAndTimestamp(db, opts);
  if (!preBody.ok) return preBody;
  return checkSignatureAndNonce(db, opts);
}
