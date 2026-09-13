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
 * **History (rounds 1-7): a lease held only on `gmail_connections` itself, checked at the final
 * write.** Rounds 1-6 closed reconnect-vs-disconnect and (round 7) disconnect-vs-disconnect races
 * by having `disconnectGmailAccount` hold an exclusive `disconnect_lease_token` on its row for the
 * whole Google-revoke window, and having this function's own `INSERT ... ON CONFLICT ... DO
 * UPDATE ... WHERE disconnect_lease_token IS NULL` refuse to write while that lease was held --
 * unconditional on the lease's freshness, never on elapsed client-side time (two earlier
 * timeout/heartbeat-based attempts at bounding it were each correctly rejected: neither one can
 * cancel the actual outbound HTTP request to Google, so elapsed time is never proof the request has
 * stopped running there).
 *
 * **Round 8's full-sweep MAJOR (GPT-PM, requested as one comprehensive review rather than one
 * finding per round): that lease lived ONLY on `gmail_connections`, and this function called
 * `exchangeCode()` BEFORE checking it at all.** The `WHERE disconnect_lease_token IS NULL` clause
 * is evaluated only on the `ON CONFLICT` (`DO UPDATE`) branch -- the plain `INSERT` branch, taken
 * whenever the row does not currently exist, evaluates no `WHERE` clause at all. Failure scenario
 * GPT-PM demonstrated: reconnect A calls `exchangeCode()` (unchecked) while disconnect B is already
 * mid-`revokeToken()` on the same account; B finishes, deletes the row (the same lease that would
 * have refused A is now gone WITH the row); A's own `INSERT` then finds no conflicting row and
 * succeeds unconditionally -- A's fresh credential is persisted as `CONNECTED` having been minted
 * inside the exact revocation window this mechanism exists to exclude.
 *
 * **The fix: a SEPARATE, never-deleted `gmail_oauth_lifecycle` row (migration
 * `0004_gmail_oauth_lifecycle_lock.sql`) that BOTH `connectGmailAccount` and `disconnectGmailAccount`
 * acquire as a single mutually exclusive lock, BEFORE either one makes its own first Google call.**
 * At most one of {a connect attempt, a disconnect attempt} may hold `lock_token` for a given account
 * at any time -- acquired here, atomically, before `exchangeCode()` is ever invoked, and held for
 * this function's ENTIRE external-call + write window, released only after the local
 * `gmail_connections` write actually completes (or on any failure, see below). Because the lock
 * lives on a row that `disconnectGmailAccount` never deletes, it survives exactly the case that
 * broke the old design: a competing disconnect deleting `gmail_connections` mid-flight can no
 * longer make this function's own exclusivity check silently disappear along with it.
 *
 * **The SAME acquisition also enforces `REVOKE_PROPAGATION_BUFFER_MS`** (GPT-PM round-8 MAJOR #2,
 * see that constant's own doc comment for the honest limits of this mitigation): the guard is
 * `lock_token IS NULL AND (revoke_settled_at IS NULL OR revoke_settled_at <= ?)`, refusing to
 * acquire (and therefore refusing `exchangeCode()`) until the configured buffer has elapsed since
 * the account's last completed revoke, not merely since the lease cleared.
 *
 * **Round-9 internal review MAJOR (architect): the credential write is now FENCED on still holding
 * this exact lock, not merely checked once at acquisition.** `exchangeCode()` is an `await` boundary
 * -- between acquiring the lock above and this function's own `db.batch()` write below, a DIFFERENT
 * actor could, in principle, steal this account's lock (see `disconnectGmailAccount`'s stale-
 * CONNECT-lock takeover, itself only safe BECAUSE of this fence). Architect demonstrated this is
 * reachable via the documented manual-recovery path: an operator clearing a wedged lock (see
 * `DisconnectAmbiguousExternalCallError`'s doc comment) while this call is still mid-`exchangeCode()`
 * opens exactly that window. The credential INSERT below is therefore written as
 * `INSERT INTO ... SELECT ... WHERE EXISTS (SELECT 1 FROM gmail_oauth_lifecycle WHERE
 * source_account_id = ? AND lock_token = ?)` -- an `INSERT ... SELECT` inserts zero rows (on EITHER
 * the plain-insert or the `ON CONFLICT` branch -- both are fed by the same `SELECT`) if the fence
 * fails, exactly the "condition the write itself, not just the branch that happens to run" fix that
 * closed round-8 finding 1 in the first place, applied here symmetrically. If the fence fails,
 * `ConnectLockLostBeforeWriteError` is thrown rather than ever reporting `CONNECTED` without having
 * actually held exclusivity for the write.
 *
 * **`DISCONNECT_IN_PROGRESS` is NOT ordinarily retryable with the same callback** (GPT-PM round-4
 * MINOR, unchanged by round 8): Google authorization codes are one-time-use, so a caller (the future
 * `services/gmail-connector` Worker, §2.1) that receives `DISCONNECT_IN_PROGRESS` MUST restart the
 * OAuth flow from `/oauth/start` for a fresh code, never retry this same callback.
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
      `INSERT INTO gmail_oauth_lifecycle (source_account_id, source, lock_token, lock_kind, lock_acquired_at)
       VALUES (?, 'gmail', ?, 'CONNECT', ?)
       ON CONFLICT (source_account_id) DO UPDATE SET
         lock_token = excluded.lock_token,
         lock_kind = excluded.lock_kind,
         lock_acquired_at = excluded.lock_acquired_at
       WHERE lock_token IS NULL AND (revoke_settled_at IS NULL OR revoke_settled_at <= ?)`,
    )
    .bind(opts.sourceAccountId, lockToken, opts.now, eligibleAfter)
    .run();

  if (acquired.meta.changes === 0) return { outcome: 'DISCONNECT_IN_PROGRESS' };

  try {
    const exchanged = await googleClient.exchangeCode(opts.code, opts.codeVerifier);
    if (!exchanged.refreshToken) {
      await releaseLifecycleLock(db, opts.sourceAccountId, lockToken);
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
    // on still holding `lockToken` (round-9 MAJOR fix, see this function's own doc comment) -- an
    // `INSERT ... SELECT ... WHERE EXISTS (...)` inserts zero rows on either branch if the fence
    // fails, rather than only checking ownership on the `ON CONFLICT` branch the way the pre-round-8
    // design did for the lock acquisition itself.
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO gmail_connections
             (source_account_id, gmail_email, encrypted_refresh_token, refresh_token_iv, kek_version,
              collection_mode, connected_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM gmail_oauth_lifecycle WHERE source_account_id = ? AND lock_token = ?
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
          opts.sourceAccountId,
          lockToken,
        ),
      db
        .prepare(
          `UPDATE gmail_oauth_lifecycle
           SET lock_token = NULL, lock_kind = NULL, lock_acquired_at = NULL, revoke_settled_at = NULL
           WHERE source_account_id = ? AND lock_token = ?`,
        )
        .bind(opts.sourceAccountId, lockToken),
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
    await releaseLifecycleLock(db, opts.sourceAccountId, lockToken);
    throw error;
  }
}

/** Shared by both `connectGmailAccount` and `disconnectGmailAccount`'s own failure paths: releases
 *  the `gmail_oauth_lifecycle` lock fenced on the exact token the caller acquired, so a retry that
 *  has already re-acquired a NEW lock can never be clobbered by this running late. Never touches
 *  `revoke_settled_at` -- only `disconnectGmailAccount`'s own successful-revoke path sets that. */
async function releaseLifecycleLock(
  db: D1Database,
  sourceAccountId: string,
  lockToken: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE gmail_oauth_lifecycle SET lock_token = NULL, lock_kind = NULL, lock_acquired_at = NULL
       WHERE source_account_id = ? AND lock_token = ?`,
    )
    .bind(sourceAccountId, lockToken)
    .run();
}

/**
 * Thrown by `connectGmailAccount` when its credential-write fence (`WHERE EXISTS (SELECT 1 FROM
 * gmail_oauth_lifecycle WHERE source_account_id = ? AND lock_token = ?)`, see that function's own
 * doc comment) finds it no longer holds the lock it acquired at the start of the call -- a
 * DIFFERENT actor (in practice: an operator/admin reconciliation step clearing a wedged lock, or a
 * disconnect that stole a stale CONNECT lock, see `disconnectGmailAccount`'s own doc comment)
 * acquired it in the window between this call's own acquisition and its final write. `exchangeCode()`
 * genuinely succeeded -- a real, live refresh token was obtained from Google -- but it was
 * deliberately NOT persisted, since doing so without exclusivity would reproduce round-8 finding 1's
 * exact failure class (a credential written without a currently-held guarantee that no competing
 * disconnect is concurrently revoking it). The caller should treat this like `DISCONNECT_IN_PROGRESS`:
 * restart the OAuth flow from `/oauth/start` for a fresh authorization code rather than retrying this
 * same callback (the code Google issued was already consumed by the `exchangeCode()` call above).
 */
export class ConnectLockLostBeforeWriteError extends Error {
  constructor(sourceAccountId: string) {
    super(
      `connectGmailAccount: the gmail_oauth_lifecycle lock for source_account_id=${sourceAccountId} ` +
        'was no longer held by the time the credential write ran (exchangeCode() succeeded, but ' +
        'persisting its result was refused to avoid writing without exclusivity). Restart the OAuth ' +
        'flow from /oauth/start for a fresh authorization code.',
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
 * `revokeToken`) itself rejects (GPT-PM round-7 MAJOR, widened to `stopWatch` by round-8 MAJOR #3 --
 * see the function's own doc comment). Distinct from an ordinary thrown error on purpose: the
 * request may have reached Google before failing locally (e.g. a connection reset after the server
 * already processed it), so whether that call's real effect at Google actually happened is UNKNOWN,
 * not merely "failed and safe to retry." The `gmail_oauth_lifecycle` lock is deliberately left held
 * when this is thrown (never released -- see the function's own doc comment) so neither a reconnect
 * nor a fresh disconnect attempt can proceed while that ambiguity is unresolved.
 *
 * **Recovering from this requires an operator/admin action that independently confirms the
 * account's actual state with Google, THEN calls `reconcileWedgedGmailDisconnectLock` (below) --
 * never a hand-written `UPDATE gmail_oauth_lifecycle SET lock_token = NULL ...`.** Round-9 internal
 * review MAJOR (architect): an earlier revision of this comment said only "clearing the lock,"
 * which is UNSAFE to follow literally -- if Google confirms the revoke genuinely happened,
 * `revoke_settled_at` MUST also be recorded at the confirmation time, or `connectGmailAccount`'s
 * `REVOKE_PROPAGATION_BUFFER_MS` guard (which reads `revoke_settled_at`) never applies, and a
 * reconnect could proceed immediately after reconciliation with zero propagation buffer --
 * defeating the exact protection round-8 MAJOR #2 added. `reconcileWedgedGmailDisconnectLock` takes
 * the confirmed outcome as an explicit parameter so this cannot be gotten wrong by omission the way
 * free-hand SQL could. `listWedgedGmailDisconnectLocks` (below) is the companion read path -- there
 * was previously no way to even find which accounts are wedged, since `lock_acquired_at` was written
 * in several places but read in none. Building a full admin UI/tool around these two primitives is
 * still out of this domain module's scope, deferred the same way the real `fetch`-backed
 * `GoogleOAuthClient` implementation and key-ring resolution are deferred to the
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
 * Conservative best-effort buffer between a successful `revokeToken()` response and treating this
 * account as eligible for a fresh `connectGmailAccount` (GPT-PM round-8 MAJOR #2, verified against
 * Google's own OAuth documentation): a 200 response from Google's revoke endpoint is NOT the same
 * claim as "revocation has taken full effect everywhere" -- Google's own documentation states
 * revocation can take additional time to propagate after a successful response. This module's
 * `GoogleOAuthClient` interface has no reconciliation/observability primitive that could confirm
 * propagation has actually finished (the same class of gap already named for cancellation -- see
 * `disconnectGmailAccount`'s own doc comment), and no Google-documented SLA exists to derive an
 * exact bound from. This buffer is therefore an honest, conservative mitigation, NOT a proven
 * safety guarantee: `connectGmailAccount`'s own lock acquisition additionally requires this much
 * time to have elapsed since `revoke_settled_at` before a fresh connect may proceed. Revisit if
 * Google ever publishes an authoritative propagation bound, or once a real reconciliation
 * capability exists (deferred to `services/gmail-connector`, §2.1, same as the rest of this
 * module's real-network concerns).
 */
const REVOKE_PROPAGATION_BUFFER_MS = 5 * 60_000;

/**
 * Round-9 internal review MAJOR (architect): a CONNECT-kind `gmail_oauth_lifecycle` lock, unlike a
 * DISCONNECT-kind one, has NO legitimate reason to ever be left held past `connectGmailAccount`'s
 * own `try`/`catch` -- every path through that function releases it (see its own doc comment), and
 * `exchangeCode()` is explicitly a one-way, non-mutating call at Google (it never revokes or stops
 * anything), so there is no "Google may have already processed it" ambiguity a stuck CONNECT lock
 * could ever be protecting. A stuck CONNECT lock can therefore only mean the process holding it
 * crashed outright (e.g. a Worker eviction) before its `catch` block ran -- pure crash debris, not a
 * safety signal. Before this fix, that debris permanently blocked `disconnectGmailAccount` too (the
 * acquisition guard did not read `lock_kind` anywhere), with no way to recover short of a hand-
 * written `UPDATE gmail_oauth_lifecycle SET lock_token = NULL ...` against undocumented invariants.
 *
 * `disconnectGmailAccount`'s acquisition guard may now steal a CONNECT-kind lock once this much
 * time has passed since `lock_acquired_at` -- but NEVER a DISCONNECT-kind one, which stays a
 * deliberate dead end exactly as before (see `disconnectGmailAccount`'s own doc comment and the
 * round-7 MAJOR #1 test). This is safe even if a "stale" CONNECT lock turns out to still be
 * genuinely in flight (a slow `exchangeCode()`, not a crash): `connectGmailAccount`'s own
 * credential-write fence (`ConnectLockLostBeforeWriteError`, above) means a late writer that lost
 * the lock to a steal simply fails cleanly instead of silently overwriting whatever the stealing
 * disconnect did -- the two fixes compose. The bound itself is generous crash-debris cleanup, not a
 * correctness contract: `exchangeCode()` is a single outbound HTTP call plus a local encrypt+write,
 * which should complete in well under a minute even on a slow network.
 */
const CONNECT_LOCK_STALE_MS = 2 * 60_000;

export interface DisconnectGmailAccountOptions {
  sourceAccountId: string;
  now: string;
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
 * **History (rounds 1-7), condensed -- the full per-round arc lives in `core/DECISION_LOG.md`, not
 * repeated in full here since round 8 supersedes the mechanism it describes:** round 1 added a
 * CAS-fenced `DELETE` and an atomic `db.batch()` for local cleanup (still true today, see below).
 * Rounds 2-3 discovered Google's revocation is project-wide, not scoped to one token, and added a
 * `disconnect_lease_token` lease on `gmail_connections` itself, acquired before any Google call.
 * Rounds 4-5 each tried to bound that lease by elapsed client-side time (a timeout, then a renewal
 * heartbeat) and GPT-PM correctly rejected both: neither can cancel the real outbound HTTP request,
 * so elapsed time is never proof it stopped running at Google. Round 6 made reconnect eligibility
 * depend only on the lease being genuinely cleared, never on its stored expiry. Round 7 applied the
 * same fix to disconnect-vs-disconnect and started distinguishing WHERE a failure occurred
 * (`revokePhase`) before deciding whether releasing the lease was safe.
 *
 * **Round 8's full-sweep MAJORs (GPT-PM, requested as one comprehensive review): the
 * `disconnect_lease_token` mechanism above could not close two further gaps, both because it lived
 * ONLY on `gmail_connections` and only ever tracked ONE external call (`revokeToken`):**
 *
 * 1. This function's own lease disappeared the moment its `DELETE` ran, which meant
 *    `connectGmailAccount`'s exclusivity check (evaluated only on its `ON CONFLICT` branch) could
 *    be silently bypassed by a reconnect's plain `INSERT` landing after that `DELETE` -- see
 *    `connectGmailAccount`'s own doc comment for the full failure scenario and fix. This function's
 *    exclusivity is now provided by acquiring the SAME `gmail_oauth_lifecycle` lock
 *    `connectGmailAccount` acquires (mutually exclusive between the two), not a lease private to
 *    this function's own row.
 * 2. A successful `revokeToken()` response was treated as proof the project-wide revocation had
 *    FULLY taken effect, when Google's own documentation says propagation can continue afterward --
 *    see `REVOKE_PROPAGATION_BUFFER_MS`'s own doc comment for the fix and its honest limits.
 * 3. `stopWatch()` (Gmail's `users.stop`) is itself a remote, mutating Google API call, but a
 *    `stopWatch()` failure was treated as provably local/pre-Google, releasing the lease
 *    immediately on what could be the exact same "request reached Google, response did not reach
 *    us" ambiguity already handled for `revokeToken()`. Fixed by widening the phase tracking below
 *    to cover BOTH external calls symmetrically, and by widening
 *    `DisconnectAmbiguousExternalCallError` (renamed from `DisconnectAmbiguousRevokeError`, which
 *    named only the `revokeToken` case) to cover either one.
 *
 * **The lock and phase tracking, current design.** `externalPhase` tracks which Google-facing call
 * is in flight, set BEFORE that call so a rejection can be classified correctly:
 * - **`'stop-ambiguous'`** (the initial value, set before `stopWatch` -- nothing local happens
 *   first): a `stopWatch` rejection here is ambiguous, not provably local, exactly like a
 *   `revokeToken` rejection -- throws `DisconnectAmbiguousExternalCallError`, lock held.
 * - **`'stop-settled'`** (set once `stopWatch` resolves): a LATER failure here (decrypt, or
 *   `revokeToken` never even starting) never touched Google's revoke endpoint -- safe to release
 *   the lock immediately, `revoke_settled_at` untouched (this attempt never learned anything new
 *   about the account's revoke state).
 * - **`'revoke-ambiguous'`** (set immediately before `revokeToken`): a rejection here is the
 *   original round-7 case -- throws `DisconnectAmbiguousExternalCallError`, lock held.
 * - **`'revoke-settled'`** (set once `revokeToken` resolves): a LATER failure here (only the local
 *   `db.batch()`) means Google's revoke genuinely succeeded -- safe to release the lock, AND
 *   `revoke_settled_at` is recorded (this is what `connectGmailAccount`'s propagation buffer reads).
 *
 * **CAS-fenced local finalization** (GPT-PM round-1 MAJOR #1) -- kept as defense in depth even
 * though the lifecycle lock above should make the race it originally guarded against structurally
 * unreachable through this module's own guarded API: the final `DELETE` is fenced on the EXACT
 * `(encrypted_refresh_token, refresh_token_iv, kek_version)` tuple read when the row was claimed,
 * the same "compare against the value actually observed, not just the key" discipline
 * `transitions.ts`'s own fenced UPDATEs use -- zero rows changed reports `SUPERSEDED_BY_RECONNECT`
 * rather than a false `DISCONNECTED`.
 *
 * **Atomic local cleanup** (GPT-PM round-1 MAJOR #2, now three statements instead of two): the
 * fenced connection delete, the `oauth_flows` clear, and the lifecycle lock release/
 * `revoke_settled_at` write all run in one `db.batch()` -- a failure of any one of them leaves ALL
 * THREE unapplied (the lock stays held, handled by the `catch` block below), never a partial state
 * where e.g. the credential is gone but the lock is still held with no route to release it.
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
      `INSERT INTO gmail_oauth_lifecycle (source_account_id, source, lock_token, lock_kind, lock_acquired_at)
       VALUES (?, 'gmail', ?, 'DISCONNECT', ?)
       ON CONFLICT (source_account_id) DO UPDATE SET
         lock_token = excluded.lock_token,
         lock_kind = excluded.lock_kind,
         lock_acquired_at = excluded.lock_acquired_at
       WHERE lock_token IS NULL
          OR (lock_kind = 'CONNECT' AND lock_acquired_at <= ?)`,
    )
    .bind(opts.sourceAccountId, lockToken, opts.now, staleConnectLockBefore)
    .run();

  if (acquired.meta.changes === 0) return { outcome: 'DISCONNECT_IN_PROGRESS' };

  const row = await db
    .prepare(
      'SELECT encrypted_refresh_token, refresh_token_iv, kek_version FROM gmail_connections WHERE source_account_id = ?',
    )
    .bind(opts.sourceAccountId)
    .first<{ encrypted_refresh_token: string; refresh_token_iv: string; kek_version: string }>();

  if (row === null) {
    // Never connected, or an earlier disconnect already removed the credential row -- nothing to
    // do at Google. Release the lock we just acquired (no external call was ever made this call).
    await releaseLifecycleLock(db, opts.sourceAccountId, lockToken);
    return { outcome: 'NOT_CONNECTED' };
  }

  let externalPhase: 'stop-ambiguous' | 'stop-settled' | 'revoke-ambiguous' | 'revoke-settled' =
    'stop-ambiguous';
  try {
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
           SET lock_token = NULL, lock_kind = NULL, lock_acquired_at = NULL, revoke_settled_at = ?
           WHERE source_account_id = ? AND lock_token = ?`,
        )
        .bind(opts.now, opts.sourceAccountId, lockToken),
    ]);
    const deleteResult = results[0];
    if (deleteResult === undefined || deleteResult.meta.changes === 0) {
      // Structurally unreachable via this module's own guarded API as of round 8 (see the doc
      // comment above) -- kept as a safety net rather than asserted unreachable.
      return { outcome: 'SUPERSEDED_BY_RECONNECT' };
    }

    const lockReleaseResult = results[2];
    if (lockReleaseResult === undefined || lockReleaseResult.meta.changes === 0) {
      // Round-9 internal review MINOR (database-reviewer, symmetry with connectGmailAccount's own
      // fenced-write check): structurally this should never happen -- nothing else can steal a
      // DISCONNECT-kind lock (connectGmailAccount's own guard requires lock_token IS NULL, and a
      // second disconnect sees a non-null lock_token and is refused DISCONNECT_IN_PROGRESS before
      // it ever gets here). If it ever does, the credential row above is already gone but the lock
      // release did NOT land, which would wedge this account forever with no route to a retry --
      // fail loudly instead of silently reporting DISCONNECTED over that state.
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
      // failing locally is UNKNOWN, so the lock is deliberately left in place (NOT released) and no
      // automatic recovery is offered. See DisconnectAmbiguousExternalCallError's own doc comment.
      throw new DisconnectAmbiguousExternalCallError(error);
    }

    if (externalPhase === 'revoke-settled') {
      // Only the local batch threw, AFTER revokeToken() genuinely resolved -- release the lock and
      // record revoke_settled_at, since connectGmailAccount's propagation buffer needs to know a
      // real revoke happened even though this attempt's own local cleanup did not complete.
      await db
        .prepare(
          `UPDATE gmail_oauth_lifecycle
           SET lock_token = NULL, lock_kind = NULL, lock_acquired_at = NULL, revoke_settled_at = ?
           WHERE source_account_id = ? AND lock_token = ?`,
        )
        .bind(opts.now, opts.sourceAccountId, lockToken)
        .run();
    } else {
      // externalPhase === 'stop-settled': revokeToken was never invoked this attempt (decrypt threw
      // first), so Google's revoke state is unchanged -- release the lock without touching
      // revoke_settled_at.
      await releaseLifecycleLock(db, opts.sourceAccountId, lockToken);
    }
    throw error;
  }
}

export interface WedgedGmailDisconnectLock {
  sourceAccountId: string;
  lockAcquiredAt: string;
}

/**
 * Read path for the reconciliation primitives named in `DisconnectAmbiguousExternalCallError`'s own
 * doc comment (round-9 internal review MAJOR, architect: previously there was no way to even find a
 * wedged account -- `lock_acquired_at` was written in several places but read in none). Lists every
 * account currently holding a DISCONNECT-kind lock -- the only kind that can stay wedged
 * indefinitely (a CONNECT-kind lock either releases itself or becomes stealable after
 * `CONNECT_LOCK_STALE_MS`, see that constant's own doc comment) -- so an operator/admin tool can
 * find candidates for manual reconciliation with Google before calling
 * `reconcileWedgedGmailDisconnectLock` below. Ordering and pagination are deliberately not
 * implemented here -- MVP1 scope is single-operator/single-account (see `disconnectGmailAccount`'s
 * own doc comment on `oauth_flows`), so an unbounded scan of this table is not a real concern yet.
 */
export async function listWedgedGmailDisconnectLocks(
  db: D1Database,
): Promise<WedgedGmailDisconnectLock[]> {
  const rows = await db
    .prepare(
      `SELECT source_account_id, lock_acquired_at FROM gmail_oauth_lifecycle
       WHERE lock_kind = 'DISCONNECT'`,
    )
    .all<{ source_account_id: string; lock_acquired_at: string }>();
  return rows.results.map((row) => ({
    sourceAccountId: row.source_account_id,
    lockAcquiredAt: row.lock_acquired_at,
  }));
}

export interface ReconcileWedgedGmailDisconnectLockOptions {
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
   * buffer still applies from the confirmation time -- this is the case the earlier, unsafe "just
   * clear the lock" prose would have silently skipped. `'REVOKE_NOT_APPLICABLE'` is for the case
   * where Google confirms the revoke never actually reached it (e.g. the ambiguous failure was
   * genuinely pre-Google) -- the lock is cleared without touching `revoke_settled_at`, since nothing
   * happened at Google to buffer against.
   */
  googleConfirmedOutcome: 'REVOKE_CONFIRMED' | 'REVOKE_NOT_APPLICABLE';
}

/**
 * Write path for reconciling a wedged `DisconnectAmbiguousExternalCallError` lock -- see that
 * error's own doc comment for why this exists instead of a hand-written `UPDATE`. Fenced on the
 * exact `lockToken` supplied (same discipline as `releaseLifecycleLock`), so this is a safe no-op
 * (zero rows changed) rather than a clobber if the lock was already resolved some other way between
 * listing and calling this.
 */
export async function reconcileWedgedGmailDisconnectLock(
  db: D1Database,
  opts: ReconcileWedgedGmailDisconnectLockOptions,
): Promise<void> {
  if (opts.googleConfirmedOutcome === 'REVOKE_CONFIRMED') {
    await db
      .prepare(
        `UPDATE gmail_oauth_lifecycle
         SET lock_token = NULL, lock_kind = NULL, lock_acquired_at = NULL, revoke_settled_at = ?
         WHERE source_account_id = ? AND lock_token = ?`,
      )
      .bind(opts.now, opts.sourceAccountId, opts.lockToken)
      .run();
    return;
  }
  await releaseLifecycleLock(db, opts.sourceAccountId, opts.lockToken);
}
