/* global crypto, TextEncoder, btoa, setTimeout, clearTimeout */
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

/**
 * Races `promise` against a real wall-clock timer, rejecting with `new Error(message)` if
 * `timeoutMs` elapses first. Used by `disconnectGmailAccount` to bound its lease-holding critical
 * section (GPT-PM round-4 MAJOR) -- genuinely real-time, not the module's usual `opts.now`-string
 * determinism, because the property being guarded against is real elapsed wall-clock time during a
 * hung network call, which a caller-supplied logical timestamp cannot represent. Clears its own
 * timer on either outcome so a fast-resolving `promise` never leaves a dangling handle.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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

export type ConnectGmailAccountResult =
  | { outcome: 'CONNECTED' }
  | { outcome: 'NO_REFRESH_TOKEN' }
  | { outcome: 'DISCONNECT_IN_PROGRESS' };

/**
 * `GET /oauth/callback`'s post-consumption step (proposal §2.5): exchanges the code, then --
 * fail-closed -- refuses to touch `gmail_connections` at all if Google omitted a refresh token,
 * so a reconnect that unexpectedly doesn't yield one can never silently overwrite a working
 * connection with a token-less state. `ON CONFLICT ... DO UPDATE` makes this idempotent for both a
 * first-time connect and a reconnect while a connection row still exists (disconnect deletes the
 * row entirely, but a reconnect without an intervening disconnect is also valid per §2.5's
 * `prompt=consent` semantics).
 *
 * **`DISCONNECT_IN_PROGRESS` fence** (GPT-PM round-2/round-3 MAJOR on checkpoint 4, verified
 * against Google's own documentation -- see `disconnectGmailAccount`'s doc comment for the full
 * evidence): the `ON CONFLICT ... DO UPDATE ... WHERE` clause refuses to write while
 * `disconnectGmailAccount` holds an active (unexpired) lease on this row. Without this, a reconnect
 * landing during an unrelated disconnect's Google-side revoke call would issue a credential that
 * revoke call then invalidates -- Google's revocation is project-wide, not scoped to the single
 * token passed to the endpoint, so no amount of purely-local fencing on the connect side alone
 * could close this; the disconnect side must hold an exclusive window instead.
 *
 * **`DISCONNECT_IN_PROGRESS` is NOT ordinarily retryable with the same callback** (GPT-PM round-4
 * MINOR): `exchangeCode` above runs BEFORE this guard, and Google authorization codes are one-time-
 * use -- by the time this function can even observe an active disconnect lease, the code has already
 * been irreversibly consumed at Google. A caller (the future `services/gmail-connector` Worker,
 * §2.1) that receives `DISCONNECT_IN_PROGRESS` from this function MUST treat it as "the OAuth flow
 * needs to be restarted from `/oauth/start` for a fresh code," never as "retry this same callback
 * shortly" -- retrying with the same, already-consumed code will fail at Google regardless of
 * whether the disconnect lease has since cleared.
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

  const result = await db
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
         updated_at = excluded.updated_at
       WHERE disconnect_lease_token IS NULL OR disconnect_lease_expires_at <= ?`,
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
      opts.now,
    )
    .run();

  if (result.meta.changes === 0) return { outcome: 'DISCONNECT_IN_PROGRESS' };

  return { outcome: 'CONNECTED' };
}

export type DisconnectGmailAccountResult =
  | { outcome: 'DISCONNECTED' }
  | { outcome: 'NOT_CONNECTED' }
  | { outcome: 'SUPERSEDED_BY_RECONNECT' }
  | { outcome: 'DISCONNECT_IN_PROGRESS' };

/** How long a disconnect holds exclusive rights to revoke/finalize this account's connection before
 *  its lease is considered abandoned (e.g. the Worker instance crashed mid-revoke) and a later
 *  disconnect or reconnect may proceed. Bounded well above realistic Google API latency but short
 *  enough that a genuinely abandoned lease does not lock the account out for long. */
const DISCONNECT_LEASE_DURATION_MS = 60_000;

/**
 * Default upper bound on `disconnectGmailAccount`'s own Google-call-and-finalize critical section
 * (GPT-PM round-4 MAJOR). Deliberately well below `DISCONNECT_LEASE_DURATION_MS`, with a wide
 * safety margin, so an attempt that hits this timeout has always already aborted (and released its
 * lease -- see the `catch` block below) long before the lease's own nominal expiry could be read by
 * anyone else as "abandoned." Overridable via `DisconnectGmailAccountOptions.googleOperationTimeoutMs`
 * purely so a test can exercise the timeout path in milliseconds instead of production-scale tens of
 * seconds; production callers should accept the default.
 */
const DEFAULT_GOOGLE_OPERATION_TIMEOUT_MS = 45_000;

/**
 * `POST /oauth/disconnect` (proposal §2.5). Order matters, and is the actual property under test
 * (functional-test review, "disconnect ordering"): acquire the disconnect lease, stop the watch,
 * THEN decrypt+revoke the token, THEN delete the local row, THEN cancel any in-flight OAuth flow.
 * This ordering is the approved design (§2.5's own stated rationale: "a failure between revoke and
 * local delete still leaves the token unusable at Google even if local cleanup is retried later")
 * -- nothing in this function is deleted until every prior step succeeds, so a thrown error at any
 * point (stopWatch, decrypt, or revoke) leaves `gmail_connections` untouched and a retried call is
 * safe and idempotent (`stopWatch` on an already-stopped watch and `revokeToken` on an
 * already-revoked token are expected to be no-ops/idempotent at Google's API, the same assumption
 * G2 already makes about its own retried operations).
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
 * **Disconnect lease across the Google revoke boundary** (GPT-PM round-2/round-3 MAJOR on this
 * checkpoint, migration `0003_gmail_oauth_disconnect_lock.sql`): the round-1 CAS fix below protects
 * only the LOCAL `gmail_connections` row, but Google's revocation is documented as project-wide --
 * "Revocation removes all OAuth 2.0 scopes previously granted to a project, invalidating any issued
 * access or refresh tokens for all clients registered under that project"
 * (developers.google.com/identity/protocols/oauth2/native-app). A reconnect that lands DURING this
 * function's `revokeToken` call can issue a credential that the SAME revoke call then invalidates,
 * even though the local row holding it survives untouched. Closed by acquiring an exclusive,
 * time-bounded lease on this row (`disconnect_lease_token`/`disconnect_lease_expires_at`) in the
 * SAME atomic `UPDATE ... RETURNING` that reads the row, BEFORE calling Google at all --
 * `connectGmailAccount`'s own `ON CONFLICT ... DO UPDATE ... WHERE` refuses to write while an
 * unexpired lease is held, so a reconnect racing the revoke window is refused
 * (`DISCONNECT_IN_PROGRESS`) rather than silently issued and then invalidated underneath the local
 * state. `DISCONNECT_LEASE_DURATION_MS` bounds how long a crashed/hung disconnect can block a
 * reconnect.
 *
 * **Bounded critical section, not just a bounded lease** (GPT-PM round-4 MAJOR): a lease with a
 * fixed expiry alone does NOT guarantee this function's own Google-call phase actually finishes
 * within it -- a hung `revokeToken` call could still be genuinely in flight past
 * `DISCONNECT_LEASE_DURATION_MS`, at which point the lease reads as "expired" to a reconnect even
 * though this function has not released it and Google's revoke may still complete afterward,
 * reopening the exact project-wide-invalidation race the lease exists to close. Fixed by racing the
 * entire post-acquisition critical section (`stopWatch` -> decrypt -> `revokeToken` -> the fenced
 * local batch) against `DEFAULT_GOOGLE_OPERATION_TIMEOUT_MS` (well below the lease's own duration,
 * with a wide safety margin): if the section has not finished by then, this function treats it as a
 * failure and takes the SAME release-on-failure path as any other error, so the lease is never left
 * silently held past a bound far shorter than its own nominal expiry. This narrows, but does not
 * claim to eliminate, one specific residual case honestly: if the injected `GoogleOAuthClient`'s
 * `revokeToken` cannot actually be cancelled (this module has no `AbortSignal` in its interface --
 * the real `fetch`-backed implementation is deferred to the `services/gmail-connector` Worker,
 * §2.1), the underlying HTTP call to Google may still complete on Google's servers after this
 * function has already given up and released the lease. The real implementation SHOULD support
 * genuine cancellation (an `AbortSignal` threaded through to `fetch`) so a timed-out attempt does
 * not merely stop watching its own promise but actually stops the outbound request.
 *
 * **CAS-fenced local finalization** (GPT-PM round-1 MAJOR #1 on this checkpoint) -- kept as
 * defense in depth once the lease above has expired (e.g. this function crashed after revoking but
 * before deleting): the final `DELETE` is fenced on the EXACT
 * `(encrypted_refresh_token, refresh_token_iv, kek_version)` tuple read when the lease was acquired,
 * the same "compare against the value actually observed, not just the key" discipline
 * `transitions.ts`'s own fenced UPDATEs use -- zero rows changed means a reconnect won the race
 * after the lease lapsed, reported as `SUPERSEDED_BY_RECONNECT` rather than a false `DISCONNECTED`.
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
export interface DisconnectGmailAccountOptions {
  sourceAccountId: string;
  now: string;
  /** Overrides `DEFAULT_GOOGLE_OPERATION_TIMEOUT_MS` -- see that constant's doc comment. Test-only
   *  escape hatch; production callers should omit this. */
  googleOperationTimeoutMs?: number;
}

export async function disconnectGmailAccount(
  db: D1Database,
  kek: CryptoKey,
  googleClient: GoogleOAuthClient,
  opts: DisconnectGmailAccountOptions,
): Promise<DisconnectGmailAccountResult> {
  const leaseToken = generateRandomToken();
  const leaseExpiresAt = new Date(
    Date.parse(opts.now) + DISCONNECT_LEASE_DURATION_MS,
  ).toISOString();

  const row = await db
    .prepare(
      `UPDATE gmail_connections
       SET disconnect_lease_token = ?, disconnect_lease_expires_at = ?
       WHERE source_account_id = ?
         AND (disconnect_lease_token IS NULL OR disconnect_lease_expires_at <= ?)
       RETURNING encrypted_refresh_token, refresh_token_iv, kek_version`,
    )
    .bind(leaseToken, leaseExpiresAt, opts.sourceAccountId, opts.now)
    .first<{ encrypted_refresh_token: string; refresh_token_iv: string; kek_version: string }>();

  if (row === null) {
    // Either no connection exists at all, or another disconnect already holds an unexpired lease
    // on it -- distinguish the two purely for the caller's reporting, since neither case may
    // proceed regardless of which it is.
    const existing = await db
      .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
      .bind(opts.sourceAccountId)
      .first();
    return existing === null ? { outcome: 'NOT_CONNECTED' } : { outcome: 'DISCONNECT_IN_PROGRESS' };
  }

  const timeoutMs = opts.googleOperationTimeoutMs ?? DEFAULT_GOOGLE_OPERATION_TIMEOUT_MS;

  try {
    return await withTimeout(
      (async (): Promise<DisconnectGmailAccountResult> => {
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
          // Only reachable if the disconnect lease above already expired (e.g. this call stalled
          // past DISCONNECT_LEASE_DURATION_MS) and a reconnect then won the race and upserted a
          // new row -- the row that exists now is NOT the one we just revoked, so deleting it
          // would destroy a live credential.
          return { outcome: 'SUPERSEDED_BY_RECONNECT' };
        }

        return { outcome: 'DISCONNECTED' };
      })(),
      timeoutMs,
      `disconnectGmailAccount: Google/D1 finalization exceeded ${timeoutMs}ms`,
    );
  } catch (error) {
    // Release the lease immediately on any failure (stopWatch/decrypt/revoke/batch) rather than
    // leaving a retry blocked for the full DISCONNECT_LEASE_DURATION_MS by this failed attempt's
    // own now-abandoned lease. Fenced on the exact lease token this call acquired, so a retry that
    // already re-acquired a NEW lease (after this lease's own natural expiry) can never be
    // clobbered by this cleanup running late.
    await db
      .prepare(
        `UPDATE gmail_connections
         SET disconnect_lease_token = NULL, disconnect_lease_expires_at = NULL
         WHERE source_account_id = ? AND disconnect_lease_token = ?`,
      )
      .bind(opts.sourceAccountId, leaseToken)
      .run();
    throw error;
  }
}
