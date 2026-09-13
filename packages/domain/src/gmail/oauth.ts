/* global crypto, TextEncoder, btoa */
// Web Platform APIs ambient under both Node (tests) and the Cloudflare Workers runtime
// (production) -- no import needed either way, same convention as packages/domain/src/auth/hmac.ts
// and packages/domain/src/gmail/crypto.ts.
import type { D1Database } from '@cloudflare/workers-types';

import { encryptRefreshToken, decryptRefreshToken } from './crypto.js';
import type { RefreshTokenAad } from './crypto.js';
import type { webcrypto } from 'node:crypto';
type CryptoKey = webcrypto.CryptoKey;

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 PKCE `code_verifier`: 32 random bytes -> a 43-char base64url string, within the spec's
 *  required 43-128 char range. Also reused for the OAuth `state` parameter (proposal §2.5 calls for
 *  "random, unguessable" -- the same CSPRNG-backed shape satisfies both uses). */
export function generateRandomToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** RFC 7636 S256: `code_challenge = BASE64URL(SHA256(code_verifier))`. */
export async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(codeVerifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

export interface CreateOAuthFlowOptions {
  state: string;
  codeVerifier: string;
  now: string;
}

/** `GET /oauth/start` (proposal §2.5): stores the PKCE verifier keyed by `state`, to be looked up
 *  and consumed exactly once when Google redirects back to `/oauth/callback`. */
export async function createOAuthFlow(db: D1Database, opts: CreateOAuthFlowOptions): Promise<void> {
  await db
    .prepare('INSERT INTO oauth_flows (state, code_verifier, created_at) VALUES (?, ?, ?)')
    .bind(opts.state, opts.codeVerifier, opts.now)
    .run();
}

export type ConsumeOAuthFlowResult =
  { outcome: 'CONSUMED'; codeVerifier: string } | { outcome: 'NOT_FOUND' } | { outcome: 'EXPIRED' };

export interface ConsumeOAuthFlowOptions {
  state: string;
  now: string;
  ttlMs: number;
}

/**
 * `GET /oauth/callback` (proposal §2.5): one-time, race-safe consumption via `DELETE ... RETURNING`
 * -- a second callback with the same `state` finds no row (`NOT_FOUND`), closing the replay/reuse
 * gap named in the plan review. The row is deleted unconditionally on any lookup (expired or not),
 * since re-attempting the SAME abandoned flow after it has expired is exactly as invalid as
 * replaying it -- `EXPIRED` and `NOT_FOUND` are both terminal, non-retryable outcomes for that
 * `state`, distinguished only so a caller can log/report which one happened.
 */
export async function consumeOAuthFlow(
  db: D1Database,
  opts: ConsumeOAuthFlowOptions,
): Promise<ConsumeOAuthFlowResult> {
  const row = await db
    .prepare('DELETE FROM oauth_flows WHERE state = ? RETURNING code_verifier, created_at')
    .bind(opts.state)
    .first<{ code_verifier: string; created_at: string }>();
  if (row === null) return { outcome: 'NOT_FOUND' };
  const ageMs = Date.parse(opts.now) - Date.parse(row.created_at);
  if (ageMs > opts.ttlMs) return { outcome: 'EXPIRED' };
  return { outcome: 'CONSUMED', codeVerifier: row.code_verifier };
}

/**
 * The actual Google API calls, injected so this module's orchestration logic (ordering,
 * fail-closed-on-missing-refresh-token, encrypt-before-persist) is testable without a real network
 * call. The real `fetch`-backed implementation is the `services/gmail-connector` Worker's own
 * concern (proposal §2.1), not this domain module's.
 */
export interface GoogleOAuthClient {
  /** Exchanges an authorization code + PKCE verifier for tokens. `refreshToken` is `null` when
   *  Google's response omits one -- a genuine API-contract violation given this design always
   *  requests `access_type=offline&prompt=consent`, per proposal §2.5's reconnect semantics. */
  exchangeCode(code: string, codeVerifier: string): Promise<GoogleTokenExchangeResult>;
  /** Google's `/revoke` endpoint. */
  revokeToken(refreshToken: string): Promise<void>;
  /** `users.stop` -- stops the Gmail watch so Google is not still trying to push to a Pub/Sub topic
   *  the operator may want to keep for a future reconnect. */
  stopWatch(sourceAccountId: string): Promise<void>;
}

export interface GoogleTokenExchangeResult {
  /** `null` when Google's response omits a refresh token. A real implementation MUST map any
   *  response lacking `refresh_token` to `null`, never `''` -- `connectGmailAccount`'s fail-closed
   *  check below treats any falsy value (including `''`) as "no token", matching this contract. */
  refreshToken: string | null;
  gmailEmail: string;
}

export type CollectionMode = 'PUSH' | 'POLL';

export interface ConnectGmailAccountOptions {
  sourceAccountId: string;
  code: string;
  codeVerifier: string;
  collectionMode: CollectionMode;
  /** The key-ring version identifying which `kek` this call is encrypting under (proposal §2.7 --
   *  key-ring resolution itself is the caller's responsibility, not this module's). */
  kekVersion: string;
  now: string;
}

export type ConnectGmailAccountResult = { outcome: 'CONNECTED' } | { outcome: 'NO_REFRESH_TOKEN' };

/**
 * `GET /oauth/callback`'s post-consumption step (proposal §2.5): exchanges the code, then --
 * fail-closed -- refuses to touch `gmail_connections` at all if Google omitted a refresh token,
 * so a reconnect that unexpectedly doesn't yield one can never silently overwrite a working
 * connection with a token-less state. `ON CONFLICT ... DO UPDATE` makes this idempotent for both a
 * first-time connect and a reconnect while a connection row still exists (disconnect deletes the
 * row entirely, but a reconnect without an intervening disconnect is also valid per §2.5's
 * `prompt=consent` semantics).
 */
export async function connectGmailAccount(
  db: D1Database,
  kek: CryptoKey,
  googleClient: GoogleOAuthClient,
  opts: ConnectGmailAccountOptions,
): Promise<ConnectGmailAccountResult> {
  const exchanged = await googleClient.exchangeCode(opts.code, opts.codeVerifier);
  if (!exchanged.refreshToken) return { outcome: 'NO_REFRESH_TOKEN' };

  const aad: RefreshTokenAad = {
    gmailAccountId: opts.sourceAccountId,
    kekVersion: opts.kekVersion,
  };
  const encrypted = await encryptRefreshToken(kek, exchanged.refreshToken, aad);

  await db
    .prepare(
      `INSERT INTO gmail_connections
         (source_account_id, gmail_email, encrypted_refresh_token, refresh_token_iv, kek_version,
          collection_mode, connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_account_id) DO UPDATE SET
         gmail_email = excluded.gmail_email,
         encrypted_refresh_token = excluded.encrypted_refresh_token,
         refresh_token_iv = excluded.refresh_token_iv,
         kek_version = excluded.kek_version,
         collection_mode = excluded.collection_mode,
         updated_at = excluded.updated_at`,
    )
    .bind(
      opts.sourceAccountId,
      exchanged.gmailEmail,
      encrypted.ciphertext,
      encrypted.iv,
      opts.kekVersion,
      opts.collectionMode,
      opts.now,
      opts.now,
    )
    .run();

  return { outcome: 'CONNECTED' };
}

export type DisconnectGmailAccountResult =
  | { outcome: 'DISCONNECTED' }
  | { outcome: 'NOT_CONNECTED' }
  | { outcome: 'SUPERSEDED_BY_RECONNECT' };

/**
 * `POST /oauth/disconnect` (proposal §2.5). Order matters, and is the actual property under test
 * (functional-test review, "disconnect ordering"): stop the watch, THEN decrypt+revoke the token,
 * THEN delete the local row, THEN cancel any in-flight OAuth flow. This ordering is the approved
 * design (§2.5's own stated rationale: "a failure between revoke and local delete still leaves the
 * token unusable at Google even if local cleanup is retried later") -- nothing in this function is
 * deleted until every prior step succeeds, so a thrown error at any point (stopWatch, decrypt, or
 * revoke) leaves `gmail_connections` untouched and a retried call is safe and idempotent (`stopWatch`
 * on an already-stopped watch and `revokeToken` on an already-revoked token are expected to be
 * no-ops/idempotent at Google's API, the same assumption G2 already makes about its own retried
 * operations).
 *
 * **Tracked risk, not a defect in this function** (security review, checkpoint 4): `kek` is a
 * single `CryptoKey` supplied by the caller, while `row.kek_version` records which key-ring version
 * actually encrypted this row. If a future caller (the `services/gmail-connector` Worker, §2.1)
 * ever passes a key that does NOT match `row.kek_version` -- e.g. naively always importing the
 * newest `GMAIL_KEK_V{n}` instead of resolving the row's own version from the key ring -- `decrypt`
 * fails deterministically and PERMANENTLY for that row (unlike a transient `stopWatch`/`revokeToken`
 * network failure, no retry with the SAME wrong key ever succeeds). Key-ring resolution is already
 * explicitly out of this checkpoint's scope (mirrors checkpoint 3's own GPT-PM-endorsed framing:
 * "the future caller still has to choose the matching versioned key... that responsibility is
 * expressly deferred by this checkpoint rather than missing from the primitive itself") -- the
 * Worker checkpoint that supplies the real `kek` argument MUST resolve the exact key for
 * `row.kek_version`, not a single default, or this exact permanent-stuck-row failure mode becomes
 * live.
 *
 * **CAS-fenced local finalization** (GPT-PM round-1 MAJOR #1 on this checkpoint): the row read at
 * the top is NOT re-read before the final `DELETE` -- a concurrent `connectGmailAccount` reconnect
 * for the SAME account, racing between this function's own SELECT and its local cleanup, would
 * `ON CONFLICT ... DO UPDATE` a fresh credential (new ciphertext/IV/`kek_version`) into the row
 * before this function's unfenced `DELETE FROM gmail_connections WHERE source_account_id = ?` ran --
 * destroying the freshly-reconnected credential while reporting a misleading `DISCONNECTED`. Fixed
 * by fencing the DELETE on the EXACT `(encrypted_refresh_token, refresh_token_iv, kek_version)`
 * tuple read at the top, the same "compare against the value actually observed, not just the key"
 * discipline `transitions.ts`'s own fenced UPDATEs use -- zero rows changed means a concurrent
 * reconnect won the race, reported as `SUPERSEDED_BY_RECONNECT` rather than a false `DISCONNECTED`.
 * The already-revoked old token is harmless either way (`revokeToken` already ran against T1, which
 * is dead at Google regardless of what happens locally); what this closes is deleting the WRONG
 * (newer) row.
 *
 * **Atomic local cleanup** (GPT-PM round-1 MAJOR #2): the fenced connection delete and the
 * `oauth_flows` clear run in one `db.batch()` (the same atomic-multi-statement pattern
 * `lease.ts`'s `completeProcessing`/`transitions.ts`'s `moveToDlq` already use) rather than as two
 * independent statements -- a failure of the second statement no longer leaves the connection row
 * already gone (which would make a retry return `NOT_CONNECTED` and never reach `oauth_flows`
 * cleanup again) while stale OAuth flow state survives until its own TTL.
 *
 * `oauth_flows` has no account-scoping column (its PK is `state` alone) -- this project's MVP1
 * scope is single-operator/single-account, so "cancels any in-flight `oauth_flows` row for that
 * account" is implemented as clearing the whole table, the only reading the actual schema shape
 * supports. Revisit when a second account is ever added (security review, checkpoint 4).
 */
export async function disconnectGmailAccount(
  db: D1Database,
  kek: CryptoKey,
  googleClient: GoogleOAuthClient,
  opts: { sourceAccountId: string },
): Promise<DisconnectGmailAccountResult> {
  const row = await db
    .prepare(
      'SELECT encrypted_refresh_token, refresh_token_iv, kek_version FROM gmail_connections WHERE source_account_id = ?',
    )
    .bind(opts.sourceAccountId)
    .first<{ encrypted_refresh_token: string; refresh_token_iv: string; kek_version: string }>();
  if (row === null) return { outcome: 'NOT_CONNECTED' };

  await googleClient.stopWatch(opts.sourceAccountId);

  const aad: RefreshTokenAad = {
    gmailAccountId: opts.sourceAccountId,
    kekVersion: row.kek_version,
  };
  const refreshToken = await decryptRefreshToken(
    kek,
    { ciphertext: row.encrypted_refresh_token, iv: row.refresh_token_iv },
    aad,
  );
  await googleClient.revokeToken(refreshToken);

  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM gmail_connections
         WHERE source_account_id = ? AND encrypted_refresh_token = ? AND refresh_token_iv = ? AND kek_version = ?`,
      )
      .bind(
        opts.sourceAccountId,
        row.encrypted_refresh_token,
        row.refresh_token_iv,
        row.kek_version,
      ),
    db.prepare('DELETE FROM oauth_flows'),
  ]);
  const deleteResult = results[0];
  if (deleteResult === undefined || deleteResult.meta.changes === 0) {
    // A concurrent reconnect upserted a new row between our SELECT and this DELETE -- the row that
    // exists now is NOT the one we just revoked, so deleting it would destroy a live credential.
    return { outcome: 'SUPERSEDED_BY_RECONNECT' };
  }

  return { outcome: 'DISCONNECTED' };
}
