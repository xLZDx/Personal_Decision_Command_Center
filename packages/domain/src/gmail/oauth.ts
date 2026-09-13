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
 * fail-closed -- refuses to touch `gmail_connections` at all if Google omitted a refresh token,
 * so a reconnect that unexpectedly doesn't yield one can never silently overwrite a working
 * connection with a token-less state. `ON CONFLICT ... DO UPDATE` makes this idempotent for both a
 * first-time connect and a reconnect while a connection row still exists (disconnect deletes the
 * row entirely, but a reconnect without an intervening disconnect is also valid per §2.5's
 * `prompt=consent` semantics).
 *
 * **`DISCONNECT_IN_PROGRESS` fence, unconditional on lease PRESENCE (not freshness)** (GPT-PM
 * round-2 through round-6 MAJOR on checkpoint 4, verified against Google's own documentation --
 * see `disconnectGmailAccount`'s doc comment for the full evidence and the round-5/6 history of why
 * two earlier attempts at this were each found unsafe): the `ON CONFLICT ... DO UPDATE ... WHERE`
 * clause refuses to write whenever `disconnect_lease_token IS NOT NULL` on this row -- regardless of
 * `disconnect_lease_expires_at`. Without this, a reconnect landing during an unrelated disconnect's
 * Google-side revoke call would issue a credential that revoke call then invalidates -- Google's
 * revocation is project-wide, not scoped to the single token passed to the endpoint, so no amount of
 * purely-local fencing on the connect side alone could close this; the disconnect side must hold an
 * exclusive window instead. That window is deliberately NOT time-bounded from connect's perspective:
 * `disconnectGmailAccount` never knows in advance how long a genuine Google revoke call will take,
 * and no client-side elapsed-time signal (a timeout, a renewal heartbeat) can prove the actual
 * outbound HTTP request has stopped running at Google -- only the row's lease actually clearing
 * (via `disconnectGmailAccount` completing, or being retried to completion) is honest proof. A
 * disconnect that crashes mid-flight leaves the account's lease held until a LATER
 * `disconnectGmailAccount` call is retried for the same account (safe and idempotent, per that
 * function's own doc comment) and actually finishes -- never resolved by `connectGmailAccount`
 * itself silently timing out and proceeding.
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
       WHERE disconnect_lease_token IS NULL`,
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

  if (result.meta.changes === 0) return { outcome: 'DISCONNECT_IN_PROGRESS' };

  return { outcome: 'CONNECTED' };
}

export type DisconnectGmailAccountResult =
  | { outcome: 'DISCONNECTED' }
  | { outcome: 'NOT_CONNECTED' }
  | { outcome: 'SUPERSEDED_BY_RECONNECT' }
  | { outcome: 'DISCONNECT_IN_PROGRESS' };

/**
 * How long a disconnect holds exclusive rights to revoke/finalize this account's connection before
 * its lease is considered abandoned (e.g. the Worker process crashed mid-revoke, outright, not
 * merely a caught error -- a caught error releases the lease immediately via the function's own
 * `catch` block) and a LATER `disconnectGmailAccount` retry for the SAME account may take over and
 * redo the sequence. Bounded well above realistic Google API latency but short enough that a
 * genuinely abandoned lease does not lock out disconnect retries for long.
 *
 * **Governs disconnect-vs-disconnect contention only** (GPT-PM round-6 MAJOR, see the full history
 * in `disconnectGmailAccount`'s own doc comment): this constant has NO bearing on when
 * `connectGmailAccount` may proceed -- that guard checks only whether a lease is present at all,
 * never how old it is. Two earlier designs (round 4's client-side timeout, round 5's renewal
 * heartbeat) tried to make THIS duration also govern reconnect eligibility and were both found
 * unsafe: no amount of elapsed client-side time can prove Google's revoke has actually stopped
 * running, so treating "the lease looks old" as permission for a DIFFERENT kind of operation
 * (reconnect) to proceed was the actual defect, not the specific duration chosen.
 */
const DISCONNECT_LEASE_DURATION_MS = 60_000;

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
 * **Disconnect lease across the Google revoke boundary, unconditional on freshness** (GPT-PM
 * round-2 through round-6 MAJOR on this checkpoint, migration `0003_gmail_oauth_disconnect_lock.sql`
 * -- see the full history below of two earlier attempts GPT-PM correctly rejected): the round-1 CAS
 * fix further below protects only the LOCAL `gmail_connections` row, but Google's revocation is
 * documented as project-wide -- "Revocation removes all OAuth 2.0 scopes previously granted to a
 * project, invalidating any issued access or refresh tokens for all clients registered under that
 * project" (developers.google.com/identity/protocols/oauth2/native-app). A reconnect that lands
 * DURING this function's `revokeToken` call can issue a credential that the SAME revoke call then
 * invalidates, even though the local row holding it survives untouched. Closed by acquiring an
 * exclusive lease on this row (`disconnect_lease_token`/`disconnect_lease_expires_at`) in the SAME
 * atomic `UPDATE ... RETURNING` that reads the row, BEFORE calling Google at all --
 * `connectGmailAccount`'s own `ON CONFLICT ... DO UPDATE ... WHERE disconnect_lease_token IS NULL`
 * refuses to write for as long as ANY lease value is present, however old, so a reconnect racing the
 * revoke window is refused (`DISCONNECT_IN_PROGRESS`) rather than silently issued and then
 * invalidated underneath the local state.
 *
 * **Two rejected earlier attempts, kept here because the reasoning is what actually closes this,
 * not the final shape alone.** Round 4 raced this function's critical section against a client-side
 * timeout and released the lease when it fired -- GPT-PM correctly rejected it: `Promise.race`
 * stops THIS function from awaiting `revokeToken`, but does not cancel the actual outbound HTTP
 * request, so Google's revoke could still complete afterward. Round 5 replaced the timeout with a
 * renewal heartbeat that kept extending the lease's expiry for as long as this function was still
 * running, racing the critical section against "proof of a lost fence" instead of elapsed time --
 * GPT-PM correctly rejected this too, for two compounding reasons: (a) the heartbeat's own renewal
 * write could itself throw or hang, silently stalling renewal with no failure signal ever raised,
 * letting the lease's *stored* expiry lapse regardless of whether this function was still genuinely
 * working; and (b) even a CORRECTLY detected lost fence still could not cancel the real
 * `revokeToken` call already in flight -- the same uncancellable-HTTP-request problem as round 4,
 * now reachable via a different trigger. Both attempts shared the same flawed premise: that SOME
 * client-side signal (a timer, a renewal check) could stand in for actual proof that the external
 * side effect had settled. It cannot, given this module's `GoogleOAuthClient` interface has no
 * cancellation contract (`fetch`-backed cancellation is deferred to the `services/gmail-connector`
 * Worker, §2.1, same deferral as every other real-network concern in this domain module).
 *
 * **The actual fix: `disconnect_lease_expires_at` no longer governs whether RECONNECT may proceed
 * at all** -- `connectGmailAccount`'s guard checks only `IS NULL`, never the expiry, so no amount of
 * elapsed client-side time can ever authorize a reconnect while a disconnect's lease is present.
 * The lease is cleared only by an ACTUAL, DEFINITIVE settlement: this function's own success (the
 * fenced `DELETE` below, which by construction only runs after `revokeToken` has genuinely resolved)
 * or its own release-on-failure path (a genuine caught error from `stopWatch`/decrypt/`revokeToken`/
 * the batch -- see below). `disconnect_lease_expires_at` and `DISCONNECT_LEASE_DURATION_MS` still
 * exist, but now govern only DISCONNECT-vs-DISCONNECT contention (the acquisition `WHERE` clause
 * just below): if this function crashes mid-flight without ever reaching its own catch block (the
 * process dies outright, not merely a caught error), a LATER `disconnectGmailAccount` retry for the
 * SAME account may take over an expired lease and redo the whole sequence from a fresh read of the
 * row's CURRENT stored ciphertext -- safe because `stopWatch`/`revokeToken` are already documented
 * above as expected to be idempotent/no-ops when repeated, and because reconnect can never have
 * touched this row in the meantime (its own guard refuses unconditionally while any lease is
 * present). Recovering a genuinely abandoned disconnect is therefore always "retry
 * `disconnectGmailAccount` for that account," never "let `connectGmailAccount` proceed because
 * enough time passed" -- the former actually settles the external side effect; the latter only ever
 * guessed at whether it had.
 *
 * **Explicit, accepted design boundary, stated rather than hidden**: if the injected
 * `GoogleOAuthClient`'s `revokeToken` never settles at all for a given attempt (neither resolves nor
 * rejects), that ONE call's own returned promise never settles either, and its lease stays held
 * until a later retry's own acquisition supersedes it (once `DISCONNECT_LEASE_DURATION_MS` has
 * passed). This is intentional: bounding how long a single disconnect REQUEST may take is the
 * calling Worker's platform-level concern (its own request timeout, plus retrying this already-safe,
 * already-idempotent primitive), not something this domain primitive should achieve by unsafely
 * giving up its exclusivity before the real operation has genuinely concluded.
 *
 * **CAS-fenced local finalization** (GPT-PM round-1 MAJOR #1 on this checkpoint) -- kept as an
 * extra layer of defense in depth, though the round-6 fix above means the race this originally
 * guarded against (a live reconnect landing between this function's lease acquisition and its own
 * `DELETE`) should now be structurally unreachable through this module's own guarded API: the final
 * `DELETE` is fenced on the EXACT `(encrypted_refresh_token, refresh_token_iv, kek_version)` tuple
 * read when the lease was acquired, the same "compare against the value actually observed, not just
 * the key" discipline `transitions.ts`'s own fenced UPDATEs use -- zero rows changed reports
 * `SUPERSEDED_BY_RECONNECT` rather than a false `DISCONNECTED`, kept as a safety net in case a
 * future change to this module reopens a path this analysis has not foreseen.
 *
 * **Atomic local cleanup** (GPT-PM round-1 MAJOR #2): the fenced connection delete and the
 * `oauth_flows` clear run in one `db.batch()` (the same atomic-multi-statement pattern
 * `lease.ts`'s `completeProcessing`/`transitions.ts`'s `moveToDlq` already use) rather than as two
 * independent statements -- a failure of the second statement no longer leaves the connection row
 * already gone (which would make a retry return `NOT_CONNECTED` and never reach `oauth_flows`
 * cleanup again) while stale OAuth flow state survives until its own TTL.
 *
 * **Residual, narrower ambiguity, noted honestly rather than silently left implicit**: the
 * `catch` block below releases the lease (sets it back to `NULL`) on ANY thrown error from
 * `stopWatch`/decrypt/`revokeToken`/the batch, including a network-level error where the outbound
 * request to Google might have been received and processed before the connection failed locally
 * (e.g. a reset mid-response) -- in that narrow case, releasing immediately carries the same class
 * of ambiguity rounds 4-6 closed for the SLOW-BUT-ALIVE case, just for a THROWN-BUT-AMBIGUOUS one
 * instead. Not fixed here: GPT-PM has not flagged this specific case across six review rounds, and
 * closing it fully would require classifying which thrown errors are provably pre-Google (safe to
 * release immediately, e.g. a local `decryptRefreshToken` failure) versus ambiguously mid-flight
 * (unsafe to release immediately) -- a real distinction this module's current `GoogleOAuthClient`
 * interface has no way to express. Flagged for a future round rather than left invisible.
 *
 * `oauth_flows` has no account-scoping column (its PK is `state` alone) -- this project's MVP1
 * scope is single-operator/single-account, so "cancels any in-flight `oauth_flows` row for that
 * account" is implemented as clearing the whole table, the only reading the actual schema shape
 * supports. Revisit when a second account is ever added (security review, checkpoint 4).
 */
export interface DisconnectGmailAccountOptions {
  sourceAccountId: string;
  now: string;
  /** Overrides `DISCONNECT_LEASE_DURATION_MS` -- test-only escape hatch; production callers should
   *  omit this. Governs only disconnect-vs-disconnect contention (see the doc comment above); it no
   *  longer has any bearing on when `connectGmailAccount` may proceed. */
  leaseDurationMs?: number;
}

export async function disconnectGmailAccount(
  db: D1Database,
  kek: CryptoKey,
  googleClient: GoogleOAuthClient,
  opts: DisconnectGmailAccountOptions,
): Promise<DisconnectGmailAccountResult> {
  const leaseDurationMs = opts.leaseDurationMs ?? DISCONNECT_LEASE_DURATION_MS;
  const leaseToken = generateRandomToken();
  const leaseExpiresAt = new Date(Date.parse(opts.now) + leaseDurationMs).toISOString();

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

  try {
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
      // Structurally unreachable via this module's own guarded API as of round 6 (see the doc
      // comment above) -- kept as a safety net rather than asserted unreachable.
      return { outcome: 'SUPERSEDED_BY_RECONNECT' };
    }

    return { outcome: 'DISCONNECTED' };
  } catch (error) {
    // Release the lease on a genuine, settled failure (stopWatch/decrypt/revoke/batch actually
    // threw) so a retry is not blocked until DISCONNECT_LEASE_DURATION_MS elapses. Fenced on the
    // exact lease token this call acquired, so a retry that already re-acquired a NEW lease (after
    // this lease's own natural expiry) can never be clobbered by this cleanup running late. See the
    // doc comment above for the narrower, honestly-tracked residual ambiguity this still carries.
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
