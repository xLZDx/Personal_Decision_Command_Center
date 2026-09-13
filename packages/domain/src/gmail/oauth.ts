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

export type ConnectGmailAccountResult =
  | { outcome: 'CONNECTED' }
  | { outcome: 'NO_REFRESH_TOKEN' }
  | { outcome: 'DISCONNECT_IN_PROGRESS' };

/**
 * `GET /oauth/callback`'s post-consumption step (proposal §2.5): exchanges the code, then --
 * fail-closed -- refuses to touch `gmail_connections` at all if Google omitted a refresh token, so
 * a reconnect that unexpectedly doesn't yield one can never silently overwrite a working connection
 * with a token-less state.
 *
 * **History, condensed -- the full per-round narrative lives in `core/DECISION_LOG.md`.** Rounds
 * 1-7 built a lease that lived only on `gmail_connections` itself. Round 8 replaced it with a
 * separate, never-deleted `gmail_oauth_lifecycle` lock (migration `0004_gmail_oauth_lifecycle_
 * lock.sql`), acquired by both this function and `disconnectGmailAccount` BEFORE either makes its
 * own first Google call, so the lock survives a competing disconnect's deletion of
 * `gmail_connections` mid-flight. Round 9's internal review fenced the credential write itself on
 * still holding the lock at write time (`ConnectLockLostBeforeWriteError`, below) and made a stale
 * CONNECT lock stealable by disconnect (crash debris only, since `exchangeCode()` never mutates
 * anything at Google).
 *
 * **Round 10 (GPT-PM's round-9 full-sweep review): the lock was keyed PER `source_account_id`,**
 * which does not match Google's own documented revocation grain -- verified against Google's
 * primary documentation (developers.google.com/identity/protocols/oauth2/native-app, "Token
 * revocation"): revocation invalidates tokens "for all clients registered under that project," i.e.
 * for the whole app's access to that Google user, not scoped to whichever `source_account_id`
 * called revoke. Two different `source_account_id` rows for the SAME Google identity could
 * independently acquire their OWN per-account locks and never contend, so one account's disconnect/
 * revoke and a DIFFERENT account's connect could interleave freely even though Google's revoke
 * would invalidate both. **`gmail_oauth_lifecycle` is now a project-wide SINGLETON** (`source =
 * 'gmail'` is its sole primary key value, seeded once by the migration, never inserted by
 * application code) -- every connect and disconnect attempt, for EVERY account, now contends on the
 * SAME row, matching the actual blast radius. `source_account_id` on the row is now a nullable,
 * purely diagnostic column (which account currently holds the lock), not part of its identity.
 * Migration `0005_gmail_connections_unique_email.sql`'s UNIQUE index remains as defense in depth
 * (its own header comment explains why it alone could not close this gap).
 *
 * **The SAME acquisition also enforces `REVOKE_PROPAGATION_BUFFER_MS`** (see that constant's own
 * doc comment for the honest limits of this mitigation): the guard is `lock_token IS NULL AND
 * (revoke_settled_at IS NULL OR revoke_settled_at <= ?)`, refusing to acquire (and therefore
 * refusing `exchangeCode()`) until the configured buffer has elapsed since the LAST completed
 * revoke for ANY account (project-wide, matching the singleton grain above), not merely since the
 * lock cleared.
 *
 * **The credential write is fenced on still holding this exact lock at write time, not merely
 * checked once at acquisition.** `exchangeCode()` is an `await` boundary -- between acquiring the
 * lock above and this function's own `db.batch()` write below, a DIFFERENT actor could, in
 * principle, steal the lock (see `disconnectGmailAccount`'s stale-CONNECT-lock takeover, itself only
 * safe BECAUSE of this fence). The credential INSERT below is therefore written as `INSERT INTO ...
 * SELECT ... WHERE EXISTS (SELECT 1 FROM gmail_oauth_lifecycle WHERE source = 'gmail' AND
 * lock_token = ?)` -- an `INSERT ... SELECT` inserts zero rows (on EITHER the plain-insert or the
 * `ON CONFLICT` branch -- both are fed by the same `SELECT`) if the fence fails. If it fails,
 * `ConnectLockLostBeforeWriteError` is thrown rather than ever reporting `CONNECTED` without having
 * actually held exclusivity for the write.
 *
 * **`DISCONNECT_IN_PROGRESS` is NOT ordinarily retryable with the same callback**: Google
 * authorization codes are one-time-use, so a caller (the future `services/gmail-connector` Worker,
 * §2.1) that receives `DISCONNECT_IN_PROGRESS` MUST restart the OAuth flow from `/oauth/start` for a
 * fresh code, never retry this same callback.
 */
export async function connectGmailAccount(
  db: D1Database,
  kek: CryptoKey,
  googleClient: GoogleOAuthClient,
  opts: ConnectGmailAccountOptions,
): Promise<ConnectGmailAccountResult> {
  const lockToken = generateRandomToken();
  const eligibleAfter = new Date(Date.parse(opts.now) - REVOKE_PROPAGATION_BUFFER_MS).toISOString();

  const acquired = await db
    .prepare(
      `UPDATE gmail_oauth_lifecycle
       SET lock_token = ?, lock_kind = 'CONNECT', lock_acquired_at = ?, source_account_id = ?
       WHERE source = 'gmail'
         AND lock_token IS NULL
         AND (revoke_settled_at IS NULL OR revoke_settled_at <= ?)`,
    )
    .bind(lockToken, opts.now, opts.sourceAccountId, eligibleAfter)
    .run();

  if (acquired.meta.changes === 0) return { outcome: 'DISCONNECT_IN_PROGRESS' };

  try {
    const exchanged = await googleClient.exchangeCode(opts.code, opts.codeVerifier);
    if (!exchanged.refreshToken) {
      await releaseLifecycleLock(db, lockToken);
      return { outcome: 'NO_REFRESH_TOKEN' };
    }

    const aad: RefreshTokenAad = {
      gmailAccountId: opts.sourceAccountId,
      kekVersion: opts.kekVersion,
    };
    const encrypted = await encryptRefreshToken(kek, exchanged.refreshToken, aad);

    // Both statements in one batch: the credential write and the lock release/revoke_settled_at
    // reset happen together, or neither does -- a batch failure leaves the lock held (safe;
    // matches this function's own catch-all release below) rather than ever releasing exclusivity
    // without the credential actually having been persisted. The credential write is itself FENCED
    // on still holding `lockToken` (see this function's own doc comment) -- an `INSERT ... SELECT
    // ... WHERE EXISTS (...)` inserts zero rows on either branch if the fence fails.
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO gmail_connections
             (source_account_id, gmail_email, encrypted_refresh_token, refresh_token_iv, kek_version,
              collection_mode, connected_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM gmail_oauth_lifecycle WHERE source = 'gmail' AND lock_token = ?
           )
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
          lockToken,
        ),
      db
        .prepare(
          `UPDATE gmail_oauth_lifecycle
           SET lock_token = NULL, lock_kind = NULL, lock_acquired_at = NULL, source_account_id = NULL,
               revoke_settled_at = NULL, recovery_state = NULL
           WHERE source = 'gmail' AND lock_token = ?`,
        )
        .bind(lockToken),
    ]);

    const credentialWrite = results[0];
    const lockRelease = results[1];
    if (
      credentialWrite === undefined ||
      credentialWrite.meta.changes === 0 ||
      lockRelease === undefined ||
      lockRelease.meta.changes === 0
    ) {
      // The fence failed: this call no longer held `lockToken` by the time the batch ran, so the
      // credential write above did NOT happen (the `WHERE EXISTS` fence made it a no-op) even
      // though `exchangeCode()` genuinely succeeded. Never report CONNECTED without having actually
      // held exclusivity for the write -- see ConnectLockLostBeforeWriteError's own doc comment.
      throw new ConnectLockLostBeforeWriteError(opts.sourceAccountId);
    }

    return { outcome: 'CONNECTED' };
  } catch (error) {
    // Covers both exchangeCode() failing (no lingering external effect to be ambiguous about --
    // unlike revokeToken()/stopWatch() below, it is a one-way "give me a token" call that never
    // mutates anything at Google) and ConnectLockLostBeforeWriteError above (this call no longer
    // holds `lockToken`, so this release is a harmless fenced no-op) -- releasing immediately on ANY
    // failure here is always safe.
    await releaseLifecycleLock(db, lockToken);
    throw error;
  }
}

/** Shared by both `connectGmailAccount` and `disconnectGmailAccount`'s own failure paths: releases
 *  the `gmail_oauth_lifecycle` lock fenced on the exact token the caller acquired, so a retry that
 *  has already re-acquired a NEW lock can never be clobbered by this running late. Never touches
 *  `revoke_settled_at` -- only `disconnectGmailAccount`'s own successful-revoke path sets that.
 *  `recovery_state` is cleared alongside `lock_token` because the table's own CHECK constraint
 *  requires it (`recovery_state IS NULL OR lock_token IS NOT NULL`) -- in practice this path never
 *  runs while `recovery_state` is actually set (only the ambiguous-failure branch sets it, and that
 *  branch deliberately does NOT call this function), but the CHECK would reject the whole UPDATE if
 *  it were ever left out. */
async function releaseLifecycleLock(db: D1Database, lockToken: string): Promise<void> {
  await db
    .prepare(
      `UPDATE gmail_oauth_lifecycle
       SET lock_token = NULL, lock_kind = NULL, lock_acquired_at = NULL, source_account_id = NULL,
           recovery_state = NULL
       WHERE source = 'gmail' AND lock_token = ?`,
    )
    .bind(lockToken)
    .run();
}

/**
 * Thrown by `connectGmailAccount` when its credential-write fence (`WHERE EXISTS (SELECT 1 FROM
 * gmail_oauth_lifecycle WHERE source = 'gmail' AND lock_token = ?)`, see that function's own doc
 * comment) finds it no longer holds the lock it acquired at the start of the call -- a DIFFERENT
 * actor (in practice: an operator/admin reconciliation step, or a disconnect -- for ANY account,
 * since the lock is project-wide -- that stole a stale CONNECT lock, see `disconnectGmailAccount`'s
 * own doc comment) acquired it in the window between this call's own acquisition and its final
 * write. `exchangeCode()` genuinely succeeded -- a real, live refresh token was obtained from
 * Google -- but it was deliberately NOT persisted, since doing so without exclusivity would
 * reproduce the exact failure class this whole mechanism exists to prevent (a credential written
 * without a currently-held guarantee that no competing disconnect is concurrently revoking it). The
 * caller should treat this like `DISCONNECT_IN_PROGRESS`: restart the OAuth flow from
 * `/oauth/start` for a fresh authorization code rather than retrying this same callback (the code
 * Google issued was already consumed by the `exchangeCode()` call above).
 */
export class ConnectLockLostBeforeWriteError extends Error {
  constructor(sourceAccountId: string) {
    super(
      `connectGmailAccount: the project-wide gmail_oauth_lifecycle lock (acquired for ` +
        `source_account_id=${sourceAccountId}) was no longer held by the time the credential write ` +
        'ran (exchangeCode() succeeded, but persisting its result was refused to avoid writing ' +
        'without exclusivity). Restart the OAuth flow from /oauth/start for a fresh authorization ' +
        'code.',
    );
    this.name = 'ConnectLockLostBeforeWriteError';
  }
}

export type DisconnectGmailAccountResult =
  | { outcome: 'DISCONNECTED' }
  | { outcome: 'NOT_CONNECTED' }
  | { outcome: 'SUPERSEDED_BY_RECONNECT' }
  | { outcome: 'DISCONNECT_IN_PROGRESS' };

/**
 * Thrown by `disconnectGmailAccount` when an external Google call it made (`stopWatch` OR
 * `revokeToken`) itself rejects. Distinct from an ordinary thrown error on purpose: the request may
 * have reached Google before failing locally (e.g. a connection reset after the server already
 * processed it), so whether that call's real effect at Google actually happened is UNKNOWN, not
 * merely "failed and safe to retry." The `gmail_oauth_lifecycle` lock is deliberately left held
 * when this is thrown (never released), and `recovery_state` is set to `'EXTERNAL_OUTCOME_UNKNOWN'`
 * (round-10 fix, see `listWedgedGmailDisconnectLocks`'s own doc comment for why) so neither a
 * reconnect nor a fresh disconnect attempt can proceed while that ambiguity is unresolved.
 *
 * **Recovering from this requires an operator/admin action that independently confirms the
 * account's actual state with Google, THEN calls `reconcileWedgedGmailDisconnectLock` (below) --
 * never a hand-written `UPDATE gmail_oauth_lifecycle SET lock_token = NULL ...`.** If Google
 * confirms the revoke genuinely happened, `revoke_settled_at` MUST also be recorded at the
 * confirmation time, or `connectGmailAccount`'s `REVOKE_PROPAGATION_BUFFER_MS` guard (which reads
 * `revoke_settled_at`) never applies, and a reconnect could proceed immediately after reconciliation
 * with zero propagation buffer. `reconcileWedgedGmailDisconnectLock` takes the confirmed outcome as
 * an explicit parameter so this cannot be gotten wrong by omission the way free-hand SQL could.
 * `listWedgedGmailDisconnectLocks` (below) is the companion read path. Building a full admin UI/tool
 * around these two primitives is still out of this domain module's scope, deferred the same way the
 * real `fetch`-backed `GoogleOAuthClient` implementation and key-ring resolution are deferred to the
 * `services/gmail-connector` Worker, §2.1 -- but the SAFETY-CRITICAL part (the write must be atomic
 * and must not omit `revoke_settled_at` when appropriate) is not something a future admin tool
 * should have to rediscover from prose, so it lives here as a tested primitive instead. A caller
 * MUST treat this differently from an ordinary error: it is not "try again," it is "stop and
 * escalate."
 */
export class DisconnectAmbiguousExternalCallError extends Error {
  constructor(cause: unknown) {
    super(
      'disconnectGmailAccount: an external Google call (stopWatch or revokeToken) failed ' +
        'ambiguously -- Google may have already processed it before this error surfaced locally, ' +
        'so the OAuth lifecycle lock was intentionally left in place rather than released. This ' +
        'account needs explicit reconciliation before any further connect or disconnect attempt ' +
        'can safely proceed.',
      { cause },
    );
    this.name = 'DisconnectAmbiguousExternalCallError';
  }
}

/**
 * Conservative best-effort buffer between a successful `revokeToken()` response and treating the
 * Gmail OAuth surface (project-wide, see `connectGmailAccount`'s own doc comment) as eligible for a
 * fresh `connectGmailAccount` call: a 200 response from Google's revoke endpoint is NOT the same
 * claim as "revocation has taken full effect everywhere" -- Google's own documentation states
 * revocation can take additional time to propagate after a successful response. This module's
 * `GoogleOAuthClient` interface has no reconciliation/observability primitive that could confirm
 * propagation has actually finished, and no Google-documented SLA exists to derive an exact bound
 * from. This buffer is therefore an honest, conservative mitigation, NOT a proven safety guarantee.
 *
 * **This IS an accepted, explicitly-named product decision, not an oversight** (GPT-PM round-9
 * full-sweep review: "the current code and the current invariant contradict each other" between
 * this best-effort buffer and an absolute "must never reopen while propagation might remain"
 * reading of the invariant). No authoritative provider/reconciliation barrier is achievable here --
 * Google publishes no propagation SLA to build one from, and a real reconciliation capability (e.g.
 * polling a tokeninfo-style endpoint until Google itself confirms the old token is dead) is a
 * materially bigger feature than this checkpoint's `GoogleOAuthClient` interface supports, deferred
 * to `services/gmail-connector`, §2.1, same as the rest of this module's real-network concerns.
 * Given that, the accepted posture for this checkpoint is: a fixed, conservative, HONESTLY-DOCUMENTED
 * best-effort delay, not an absolute guarantee -- revisit if Google ever publishes an authoritative
 * propagation bound, or once real reconciliation tooling exists.
 */
const REVOKE_PROPAGATION_BUFFER_MS = 5 * 60_000;

/**
 * A CONNECT-kind `gmail_oauth_lifecycle` lock, unlike a DISCONNECT-kind one, has NO legitimate
 * reason to ever be left held past `connectGmailAccount`'s own `try`/`catch` -- every path through
 * that function releases it, and `exchangeCode()` is explicitly a one-way, non-mutating call at
 * Google (it never revokes or stops anything), so there is no "Google may have already processed
 * it" ambiguity a stuck CONNECT lock could ever be protecting. A stuck CONNECT lock can therefore
 * only mean the process holding it crashed outright (e.g. a Worker eviction) before its `catch`
 * block ran -- pure crash debris, not a safety signal.
 *
 * `disconnectGmailAccount`'s acquisition guard may steal a CONNECT-kind lock once this much time
 * has passed since `lock_acquired_at` -- but NEVER a DISCONNECT-kind one, which stays a deliberate
 * dead end exactly as before (see `disconnectGmailAccount`'s own doc comment). This is safe even if
 * a "stale" CONNECT lock turns out to still be genuinely in flight (a slow `exchangeCode()`, not a
 * crash): `connectGmailAccount`'s own credential-write fence (`ConnectLockLostBeforeWriteError`,
 * above) means a late writer that lost the lock to a steal simply fails cleanly instead of silently
 * overwriting whatever the stealing disconnect did -- the two fixes compose. The bound itself is
 * generous crash-debris cleanup, not a correctness contract: `exchangeCode()` is a single outbound
 * HTTP call plus a local encrypt+write, which should complete in well under a minute even on a slow
 * network.
 */
const CONNECT_LOCK_STALE_MS = 2 * 60_000;

export interface DisconnectGmailAccountOptions {
  sourceAccountId: string;
  now: string;
  /**
   * Sampled AFTER `revokeToken()` resolves, used for `revoke_settled_at` (round-10 fix, GPT-PM
   * full-sweep MAJOR): `stopWatch()` + `revokeToken()` can together take real wall-clock time, and
   * using `now` (this call's ENTRY time) for `revoke_settled_at` would silently shrink
   * `connectGmailAccount`'s propagation buffer by however long those two calls actually took --
   * up to and including making it a no-op if they took longer than
   * `REVOKE_PROPAGATION_BUFFER_MS` itself. Injected rather than read from a live clock internally,
   * matching this module's existing now-injection discipline (no bare `Date.now()`/`new Date()`
   * reads anywhere in this package): production wires `() => new Date().toISOString()`; tests
   * supply a fixed or advancing stub.
   */
  clock: () => string;
}

/**
 * `POST /oauth/disconnect` (proposal §2.5). Order matters, and is the actual property under test
 * (functional-test review, "disconnect ordering"): acquire the lifecycle lock, stop the watch, THEN
 * decrypt+revoke the token, THEN delete the local row, THEN cancel any in-flight OAuth flow. This
 * ordering is the approved design (§2.5's own stated rationale: "a failure between revoke and local
 * delete still leaves the token unusable at Google even if local cleanup is retried later") --
 * nothing in this function is deleted until every prior step succeeds, so a thrown error at any
 * point leaves `gmail_connections` untouched and a retried call is safe and idempotent (`stopWatch`
 * on an already-stopped watch and `revokeToken` on an already-revoked token are expected to be
 * no-ops/idempotent at Google's API, the same assumption G2 already makes about its own retried
 * operations).
 *
 * **Tracked risk, not a defect in this function** (security review, checkpoint 4): `kek` is a
 * single `CryptoKey` supplied by the caller, while `row.kek_version` records which key-ring version
 * actually encrypted this row. Key-ring resolution is explicitly out of this checkpoint's scope
 * (mirrors checkpoint 3's own GPT-PM-endorsed framing) -- the Worker checkpoint that supplies the
 * real `kek` argument MUST resolve the exact key for `row.kek_version`, not a single default.
 *
 * **History, condensed -- the full per-round narrative lives in `core/DECISION_LOG.md`.** Rounds
 * 1-8 built and then replaced a per-`gmail_connections`-row lease with the shared, never-deleted
 * `gmail_oauth_lifecycle` lock (see `connectGmailAccount`'s own doc comment). Round 9's internal
 * review widened `externalPhase` to track `stopWatch` and `revokeToken` symmetrically and fixed the
 * lock's own release/reconciliation bookkeeping. **Round 10 (GPT-PM's round-9 full-sweep review)
 * found and fixed three further defects, all new this round:**
 *
 * 1. **The lock was keyed per `source_account_id`, not matching Google's project-wide revocation
 *    grain** -- see `connectGmailAccount`'s own doc comment for the full failure scenario and fix
 *    (the lock is now a project-wide singleton).
 * 2. **A purely local D1 read failure (the credential `SELECT` below) was OUTSIDE the protected
 *    failure/release block**, so a transient storage error there -- no Google call ever attempted,
 *    no ambiguity to protect -- permanently wedged the account with no route to release. Fixed:
 *    the `SELECT` now runs INSIDE the same `try`, under a new initial phase, `'not-started'`, which
 *    the `catch` block treats identically to `'stop-settled'` (safe to release immediately).
 * 3. **`revoke_settled_at` was recorded using this call's ENTRY-time `now`, not the time
 *    `revokeToken()` actually resolved** -- see `DisconnectGmailAccountOptions.clock`'s own doc
 *    comment for the failure scenario and fix.
 *
 * **The lock and phase tracking, current design.** `externalPhase` tracks which Google-facing call
 * is in flight, set BEFORE that call so a rejection can be classified correctly:
 * - **`'not-started'`** (the initial value): nothing at Google has been touched yet (this covers
 *   the credential `SELECT` and any local setup before `stopWatch`) -- a failure here is provably
 *   local, safe to release the lock immediately, `revoke_settled_at` untouched.
 * - **`'stop-ambiguous'`** (set immediately before `stopWatch`): a rejection here is ambiguous, not
 *   provably local -- throws `DisconnectAmbiguousExternalCallError`, lock held, `recovery_state`
 *   set.
 * - **`'stop-settled'`** (set once `stopWatch` resolves): a LATER failure here (decrypt, or
 *   `revokeToken` never even starting) never touched Google's revoke endpoint -- safe to release
 *   the lock immediately, `revoke_settled_at` untouched.
 * - **`'revoke-ambiguous'`** (set immediately before `revokeToken`): a rejection here throws
 *   `DisconnectAmbiguousExternalCallError`, lock held, `recovery_state` set.
 * - **`'revoke-settled'`** (set once `revokeToken` resolves, using the freshly-sampled `settledAt`
 *   from `opts.clock()`): a LATER failure here (only the local `db.batch()`) means Google's revoke
 *   genuinely succeeded -- safe to release the lock, AND `revoke_settled_at` is recorded as
 *   `settledAt` (this is what `connectGmailAccount`'s propagation buffer reads).
 *
 * **CAS-fenced local finalization** (kept as defense in depth even though the lifecycle lock above
 * should make the race it originally guarded against structurally unreachable through this
 * module's own guarded API): the final `DELETE` is fenced on the EXACT `(encrypted_refresh_token,
 * refresh_token_iv, kek_version)` tuple read when the row was claimed, the same "compare against the
 * value actually observed, not just the key" discipline `transitions.ts`'s own fenced UPDATEs use --
 * zero rows changed reports `SUPERSEDED_BY_RECONNECT` rather than a false `DISCONNECTED`.
 *
 * **Atomic local cleanup** (three statements): the fenced connection delete, the `oauth_flows`
 * clear, and the lifecycle lock release/`revoke_settled_at` write all run in one `db.batch()` -- a
 * failure of any one of them leaves ALL THREE unapplied (the lock stays held, handled by the
 * `catch` block below), never a partial state where e.g. the credential is gone but the lock is
 * still held with no route to release it.
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
  opts: DisconnectGmailAccountOptions,
): Promise<DisconnectGmailAccountResult> {
  const lockToken = generateRandomToken();
  const staleConnectLockBefore = new Date(
    Date.parse(opts.now) - CONNECT_LOCK_STALE_MS,
  ).toISOString();

  const acquired = await db
    .prepare(
      `UPDATE gmail_oauth_lifecycle
       SET lock_token = ?, lock_kind = 'DISCONNECT', lock_acquired_at = ?, source_account_id = ?
       WHERE source = 'gmail'
         AND (lock_token IS NULL OR (lock_kind = 'CONNECT' AND lock_acquired_at <= ?))`,
    )
    .bind(lockToken, opts.now, opts.sourceAccountId, staleConnectLockBefore)
    .run();

  if (acquired.meta.changes === 0) return { outcome: 'DISCONNECT_IN_PROGRESS' };

  // `settledAt` is overwritten with the real post-revokeToken() clock() reading right after that
  // call resolves (see DisconnectGmailAccountOptions.clock's own doc comment) -- this initial value
  // is provably never read, since it is only used once externalPhase === 'revoke-settled', which
  // only happens after the real assignment below.
  let settledAt = opts.now;
  let externalPhase:
    'not-started' | 'stop-ambiguous' | 'stop-settled' | 'revoke-ambiguous' | 'revoke-settled' =
    'not-started';
  try {
    const row = await db
      .prepare(
        'SELECT encrypted_refresh_token, refresh_token_iv, kek_version FROM gmail_connections WHERE source_account_id = ?',
      )
      .bind(opts.sourceAccountId)
      .first<{ encrypted_refresh_token: string; refresh_token_iv: string; kek_version: string }>();

    if (row === null) {
      // Never connected, or an earlier disconnect already removed the credential row -- nothing to
      // do at Google. Release the lock we just acquired (no external call was ever made this call).
      await releaseLifecycleLock(db, lockToken);
      return { outcome: 'NOT_CONNECTED' };
    }

    externalPhase = 'stop-ambiguous';
    await googleClient.stopWatch(opts.sourceAccountId);
    externalPhase = 'stop-settled';

    const aad: RefreshTokenAad = {
      gmailAccountId: opts.sourceAccountId,
      kekVersion: row.kek_version,
    };
    const refreshToken = await decryptRefreshToken(
      kek,
      { ciphertext: row.encrypted_refresh_token, iv: row.refresh_token_iv },
      aad,
    );
    externalPhase = 'revoke-ambiguous';
    await googleClient.revokeToken(refreshToken);
    settledAt = opts.clock();
    externalPhase = 'revoke-settled';

    const results = await db.batch([
      db
        .prepare(
          `DELETE FROM gmail_connections
           WHERE source_account_id = ? AND encrypted_refresh_token = ? AND refresh_token_iv = ?
             AND kek_version = ?`,
        )
        .bind(
          opts.sourceAccountId,
          row.encrypted_refresh_token,
          row.refresh_token_iv,
          row.kek_version,
        ),
      db.prepare('DELETE FROM oauth_flows'),
      db
        .prepare(
          `UPDATE gmail_oauth_lifecycle
           SET lock_token = NULL, lock_kind = NULL, lock_acquired_at = NULL, source_account_id = NULL,
               recovery_state = NULL, revoke_settled_at = ?
           WHERE source = 'gmail' AND lock_token = ?`,
        )
        .bind(settledAt, lockToken),
    ]);
    const deleteResult = results[0];
    if (deleteResult === undefined || deleteResult.meta.changes === 0) {
      // Structurally unreachable via this module's own guarded API (see the doc comment above) --
      // kept as a safety net rather than asserted unreachable.
      return { outcome: 'SUPERSEDED_BY_RECONNECT' };
    }

    const lockReleaseResult = results[2];
    if (lockReleaseResult === undefined || lockReleaseResult.meta.changes === 0) {
      // Symmetry with connectGmailAccount's own fenced-write check: structurally this should never
      // happen -- nothing else can steal a DISCONNECT-kind lock (connectGmailAccount's own guard
      // requires lock_token IS NULL, and a second disconnect sees a non-null lock_token and is
      // refused DISCONNECT_IN_PROGRESS before it ever gets here). If it ever does, the credential
      // row above is already gone but the lock release did NOT land, which would wedge the whole
      // Gmail OAuth surface forever with no route to a retry -- fail loudly instead of silently
      // reporting DISCONNECTED over that state.
      throw new Error(
        `disconnectGmailAccount: lock release did not apply for source_account_id=` +
          `${opts.sourceAccountId} after the credential delete succeeded -- an internal invariant ` +
          'was violated (nothing else should have been able to change this lock during this call).',
      );
    }

    return { outcome: 'DISCONNECTED' };
  } catch (error) {
    if (externalPhase === 'stop-ambiguous' || externalPhase === 'revoke-ambiguous') {
      // The in-flight external call itself rejected -- whether Google actually processed it before
      // failing locally is UNKNOWN, so the lock is deliberately left in place (NOT released), and
      // recovery_state is set so listWedgedGmailDisconnectLocks can find this account -- see
      // DisconnectAmbiguousExternalCallError's own doc comment.
      await db
        .prepare(
          `UPDATE gmail_oauth_lifecycle SET recovery_state = 'EXTERNAL_OUTCOME_UNKNOWN'
           WHERE source = 'gmail' AND lock_token = ?`,
        )
        .bind(lockToken)
        .run();
      throw new DisconnectAmbiguousExternalCallError(error);
    }

    if (externalPhase === 'revoke-settled') {
      // Only the local batch threw, AFTER revokeToken() genuinely resolved -- release the lock and
      // record revoke_settled_at (the real settledAt sampled above), since connectGmailAccount's
      // propagation buffer needs to know a real revoke happened even though this attempt's own
      // local cleanup did not complete.
      await db
        .prepare(
          `UPDATE gmail_oauth_lifecycle
           SET lock_token = NULL, lock_kind = NULL, lock_acquired_at = NULL, source_account_id = NULL,
               recovery_state = NULL, revoke_settled_at = ?
           WHERE source = 'gmail' AND lock_token = ?`,
        )
        .bind(settledAt, lockToken)
        .run();
    } else {
      // externalPhase === 'not-started' or 'stop-settled': either nothing at Google was touched yet,
      // or revokeToken was never invoked this attempt (decrypt threw first) -- Google's revoke state
      // is unchanged either way, so release the lock without touching revoke_settled_at.
      await releaseLifecycleLock(db, lockToken);
    }
    throw error;
  }
}

export interface WedgedGmailDisconnectLock {
  sourceAccountId: string;
  lockToken: string;
  lockAcquiredAt: string;
}

/**
 * Read path for the reconciliation primitives named in `DisconnectAmbiguousExternalCallError`'s own
 * doc comment. Lists the account currently holding an AMBIGUOUS, genuinely-wedged DISCONNECT-kind
 * lock (at most one, since `gmail_oauth_lifecycle` is a project-wide singleton) -- filtered on
 * `recovery_state = 'EXTERNAL_OUTCOME_UNKNOWN'`, not merely `lock_kind = 'DISCONNECT'` (round-10
 * fix, GPT-PM full-sweep MAJOR): `lock_kind = 'DISCONNECT'` alone cannot distinguish a genuinely
 * stuck account from a disconnect that is simply, legitimately still executing (still inside
 * `stopWatch`/`revokeToken`, not yet caught any error) -- exposing an in-flight disconnect through
 * this "safe" recovery path would let an operator clear the exclusion protecting a still-live
 * Google call, exactly the invariant this whole mechanism exists to enforce.
 *
 * **A lock left behind by a genuine process crash (which never reached its own `catch` block, so
 * never wrote `recovery_state`) deliberately does NOT appear here.** That case needs a separate,
 * more heavyweight operator force-recovery procedure requiring independent evidence the old
 * invocation is actually dead (e.g. confirming via Cloudflare's own execution logs that the prior
 * invocation terminated) -- out of this checkpoint's scope, same deferral already applied to the
 * real `fetch`-backed `GoogleOAuthClient` implementation and key-ring resolution, §2.1. Returns the
 * `lockToken` needed by `reconcileWedgedGmailDisconnectLock` below directly (an earlier revision of
 * this function omitted it, making the exported reconciliation API impossible to use without a raw
 * SQL query first -- GPT-PM full-sweep MAJOR, caught via this function's own now-obsolete test).
 */
export async function listWedgedGmailDisconnectLocks(
  db: D1Database,
): Promise<WedgedGmailDisconnectLock[]> {
  const rows = await db
    .prepare(
      `SELECT source_account_id, lock_token, lock_acquired_at FROM gmail_oauth_lifecycle
       WHERE source = 'gmail' AND recovery_state = 'EXTERNAL_OUTCOME_UNKNOWN'`,
    )
    .all<{ source_account_id: string; lock_token: string; lock_acquired_at: string }>();
  return rows.results.map((row) => ({
    sourceAccountId: row.source_account_id,
    lockToken: row.lock_token,
    lockAcquiredAt: row.lock_acquired_at,
  }));
}

export interface ReconcileWedgedGmailDisconnectLockOptions {
  /** The account this reconciliation is FOR, from the corresponding `listWedgedGmailDisconnectLocks`
   *  row -- an additional fence alongside `lockToken` (defense in depth: the operator confirming
   *  Google's state is confirming it for a SPECIFIC account, and this makes a mismatch between what
   *  was confirmed and what gets cleared fail loudly rather than silently). */
  sourceAccountId: string;
  /** The EXACT token from `listWedgedGmailDisconnectLocks`'s corresponding row (read immediately
   *  before calling this, not cached) -- fences the release so a lock that was somehow already
   *  re-acquired by a legitimate new attempt between listing and reconciling is never clobbered. */
  lockToken: string;
  now: string;
  /**
   * The confirmed outcome of independently checking this account's actual state with Google --
   * MUST be determined by the caller outside this module (this module's `GoogleOAuthClient` has no
   * reconciliation/observability primitive, see `REVOKE_PROPAGATION_BUFFER_MS`'s own doc comment).
   * `'REVOKE_CONFIRMED'` records `revoke_settled_at = now`, so `connectGmailAccount`'s propagation
   * buffer still applies from the confirmation time -- this is the case an unsafe "just clear the
   * lock" procedure would silently skip. `'REVOKE_NOT_APPLICABLE'` is for the case where Google
   * confirms the revoke never actually reached it (e.g. the ambiguous failure was genuinely
   * pre-Google) -- the lock is cleared without touching `revoke_settled_at`, since nothing happened
   * at Google to buffer against (any PRIOR `revoke_settled_at` value, from an earlier unrelated
   * revoke, is left untouched either way).
   */
  googleConfirmedOutcome: 'REVOKE_CONFIRMED' | 'REVOKE_NOT_APPLICABLE';
}

export type ReconcileWedgedGmailDisconnectLockResult = 'RECONCILED' | 'STALE_LOCK';

/**
 * Write path for reconciling a wedged `DisconnectAmbiguousExternalCallError` lock -- see that
 * error's own doc comment for why this exists instead of a hand-written `UPDATE`. Fenced on both
 * `sourceAccountId` and the exact `lockToken` supplied, so this is a safe no-op (zero rows changed,
 * reported as `'STALE_LOCK'` rather than silently swallowed -- round-10 fix, GPT-PM full-sweep
 * MAJOR: an earlier revision returned `void` unconditionally, so a stale token was indistinguishable
 * from a real reconciliation, and a caller following only this function's own contract could report
 * "reconciliation complete" while the account remained permanently locked) if the lock was already
 * resolved some other way between listing and calling this.
 */
export async function reconcileWedgedGmailDisconnectLock(
  db: D1Database,
  opts: ReconcileWedgedGmailDisconnectLockOptions,
): Promise<ReconcileWedgedGmailDisconnectLockResult> {
  const revokeSettledAt = opts.googleConfirmedOutcome === 'REVOKE_CONFIRMED' ? opts.now : null;
  const result = await db
    .prepare(
      `UPDATE gmail_oauth_lifecycle
       SET lock_token = NULL, lock_kind = NULL, lock_acquired_at = NULL, source_account_id = NULL,
           recovery_state = NULL, revoke_settled_at = COALESCE(?, revoke_settled_at)
       WHERE source = 'gmail' AND source_account_id = ? AND lock_token = ?`,
    )
    .bind(revokeSettledAt, opts.sourceAccountId, opts.lockToken)
    .run();
  return result.meta.changes === 0 ? 'STALE_LOCK' : 'RECONCILED';
}
