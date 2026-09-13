import type { D1Database } from '@cloudflare/workers-types';

/** A fixed instant so fixtures and assertions agree on "now" without a live clock. */
export const FIXTURE_NOW = '2026-09-13T00:00:00.000Z';

export interface SeedAccountsResult {
  userId: string;
  gmailAccountId: string;
  gmailPolicyId: string;
  telegramAccountId: string;
  telegramPolicyId: string;
}

/**
 * Baseline rows every ingest_events row needs a valid FK to: one user, one ALLOW-policy Gmail
 * account and one DENY-policy Telegram account -- mirrors the scratch validate.py/validate3.py
 * harness's own baseline setup, kept here so every domain test starts from the same known-good
 * ground instead of re-deriving it.
 */
export async function seedBaselineAccounts(db: D1Database): Promise<SeedAccountsResult> {
  const userId = 'u-test';
  const gmailAccountId = 'acc-gmail-test';
  const telegramAccountId = 'acc-telegram-test';
  const gmailPolicyId = 'pol-gmail-allow';
  const telegramPolicyId = 'pol-telegram-deny';

  await db
    .prepare('INSERT INTO users (user_id, email, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(userId, 'test@example.com', FIXTURE_NOW, FIXTURE_NOW)
    .run();

  await db
    .prepare(
      'INSERT INTO source_accounts (source_account_id, user_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(gmailAccountId, userId, 'gmail', FIXTURE_NOW, FIXTURE_NOW)
    .run();
  await db
    .prepare(
      'INSERT INTO source_accounts (source_account_id, user_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(telegramAccountId, userId, 'telegram', FIXTURE_NOW, FIXTURE_NOW)
    .run();

  await db
    .prepare(
      'INSERT INTO source_policies (source_policy_id, source, ai_policy, version, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(gmailPolicyId, 'gmail', 'ALLOW', 1, FIXTURE_NOW)
    .run();
  await db
    .prepare(
      'INSERT INTO source_policies (source_policy_id, source, ai_policy, version, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(telegramPolicyId, 'telegram', 'DENY', 1, FIXTURE_NOW)
    .run();

  return { userId, gmailAccountId, gmailPolicyId, telegramAccountId, telegramPolicyId };
}

export interface SeedEventOptions {
  eventId: string;
  source?: 'gmail' | 'telegram';
  sourceAccountId?: string;
  sourcePolicyId?: string;
  eventType?: 'MESSAGE_CREATED' | 'MESSAGE_UPDATED' | 'MESSAGE_DELETED';
  sourceVersion?: string | null;
  state?: 'ACCEPTED' | 'PROCESSING' | 'PROCESSED' | 'RETRYABLE_FAILED' | 'DLQ';
  attemptCount?: number;
  leaseOwner?: string | null;
  leaseToken?: string | null;
  leaseExpiresAt?: string | null;
  firstFailedAt?: string | null;
  idempotencyKey?: string;
}

/** Mirrors validate3.py's `insert_event()` -- a directly-inserted row for state-machine tests that
 *  need to start from an arbitrary mid-pipeline state, not from a real ingest call. */
export async function seedEvent(
  db: D1Database,
  accounts: SeedAccountsResult,
  opts: SeedEventOptions,
): Promise<void> {
  const source = opts.source ?? 'gmail';
  const sourceAccountId =
    opts.sourceAccountId ??
    (source === 'gmail' ? accounts.gmailAccountId : accounts.telegramAccountId);
  const sourcePolicyId =
    opts.sourcePolicyId ??
    (source === 'gmail' ? accounts.gmailPolicyId : accounts.telegramPolicyId);

  await db
    .prepare(
      `INSERT INTO ingest_events
        (event_id, source, source_account_id, source_event_id, event_type, direction,
         occurred_at, received_at, content_locator_ref, source_policy_id, trace_id,
         schema_version, source_version, idempotency_key, state,
         processing_attempt_count, processing_lease_owner, processing_lease_token,
         processing_lease_expires_at, first_failed_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      opts.eventId,
      source,
      sourceAccountId,
      `src-${opts.eventId}`,
      opts.eventType ?? 'MESSAGE_CREATED',
      'INBOUND',
      FIXTURE_NOW,
      FIXTURE_NOW,
      `ref-${opts.eventId}`,
      sourcePolicyId,
      `trace-${opts.eventId}`,
      4,
      opts.sourceVersion ?? null,
      opts.idempotencyKey ?? `idem-${opts.eventId}`,
      opts.state ?? 'ACCEPTED',
      opts.attemptCount ?? 0,
      opts.leaseOwner ?? null,
      opts.leaseToken ?? null,
      opts.leaseExpiresAt ?? null,
      opts.firstFailedAt ?? null,
      FIXTURE_NOW,
    )
    .run();
}

export async function seedOutbox(
  db: D1Database,
  eventId: string,
  opts: {
    state?: 'PENDING' | 'DISPATCHED' | 'RETRY_PENDING' | 'BUDGET_DEFERRED' | 'CLOSED';
    dispatchCount?: number;
    nextAttemptAt?: string;
    dispatchedAt?: string | null;
  } = {},
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO processing_outbox (event_id, state, dispatch_count, next_attempt_at, dispatched_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      eventId,
      opts.state ?? 'PENDING',
      opts.dispatchCount ?? 0,
      opts.nextAttemptAt ?? FIXTURE_NOW,
      opts.dispatchedAt ?? null,
      FIXTURE_NOW,
    )
    .run();
}

/** A deliberately small effective cap for budget tests -- the schema's own CHECK ceiling (2500)
 *  is a hard maximum, never a test-sized value; the actual per-call cap is always a runtime
 *  parameter (TDD's "configurable downward without review" rule), and this is that parameter. */
export function testBudgetCap(n: number): { cap: number } {
  return { cap: n };
}

export interface SeedSigningKeyOptions {
  connectorId: string;
  keyVersion: string;
  status?: 'ACTIVE' | 'REVOKED';
  validFrom?: string;
  validUntil?: string | null;
}

/** Metadata-only fixture -- no secret bytes here or in the real table; the matching HMAC secret
 *  lives only in the test's own local variable, standing in for a Worker Secret binding. */
export async function seedSigningKey(db: D1Database, opts: SeedSigningKeyOptions): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ingest_signing_keys (connector_id, key_version, status, valid_from, valid_until)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      opts.connectorId,
      opts.keyVersion,
      opts.status ?? 'ACTIVE',
      opts.validFrom ?? FIXTURE_NOW,
      opts.validUntil ?? null,
    )
    .run();
}

/** A fixed test-only secret, standing in for a Cloudflare Worker Secret binding value -- never
 *  written to D1 (ingest_signing_keys is metadata-only by design). */
export const TEST_HMAC_SECRET = 'test-only-hmac-secret-do-not-use-in-production';

export interface SeedGmailConnectionOptions {
  sourceAccountId: string;
  watchHistoryId?: string | null;
  connectedAt?: string;
  collectionMode?: 'PUSH' | 'POLL';
}

/** A minimal `gmail_connections` row -- token/KEK fields are inert placeholders, never real
 *  ciphertext; tests exercising `oauth.ts`'s crypto path seed those fields directly instead. */
export async function seedGmailConnection(
  db: D1Database,
  opts: SeedGmailConnectionOptions,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO gmail_connections
        (source_account_id, source, gmail_email, encrypted_refresh_token, refresh_token_iv,
         kek_version, collection_mode, watch_history_id, watch_expiration, connected_at, updated_at)
       VALUES (?, 'gmail', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      opts.sourceAccountId,
      `${opts.sourceAccountId}@example.com`,
      'encrypted-refresh-token-placeholder',
      'iv-placeholder',
      'v1',
      opts.collectionMode ?? 'POLL',
      opts.watchHistoryId ?? null,
      null,
      opts.connectedAt ?? FIXTURE_NOW,
      FIXTURE_NOW,
    )
    .run();
}

export interface SeedSourceCursorOptions {
  sourceAccountId: string;
  /** The opaque cursor JSON string, or `null` for "row exists but no cursor set yet". */
  cursorValue?: string | null;
}

export async function seedSourceCursor(
  db: D1Database,
  opts: SeedSourceCursorOptions,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_cursors (source_account_id, cursor_value, updated_at) VALUES (?, ?, ?)`,
    )
    .bind(opts.sourceAccountId, opts.cursorValue ?? null, FIXTURE_NOW)
    .run();
}
