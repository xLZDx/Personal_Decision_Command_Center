/* global crypto, TextEncoder, btoa */
import { describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestD1, loadG3Schema, seedBaselineAccounts, FIXTURE_NOW } from '@pdos/testkit';

import { importKek, decryptRefreshToken } from '../../src/gmail/crypto.js';
import {
  generateRandomToken,
  computeCodeChallenge,
  createOAuthFlow,
  consumeOAuthFlow,
  connectGmailAccount,
  disconnectGmailAccount,
  DisconnectAmbiguousExternalCallError,
  DisconnectRecoveryMarkerWriteFailedError,
  LifecycleLockRecoveryFailedError,
  ConnectLockLostBeforeWriteError,
  listWedgedGmailDisconnectLocks,
  reconcileWedgedGmailDisconnectLock,
} from '../../src/gmail/oauth.js';
import type {
  GoogleOAuthClient,
  GoogleTokenExchangeResult,
  ConnectGmailAccountResult,
  DisconnectGmailAccountResult,
} from '../../src/gmail/oauth.js';

async function setup() {
  const db = createTestD1(loadG3Schema());
  const accounts = await seedBaselineAccounts(db);
  const kek = await importKek(testKekSecret());
  return { db, accounts, kek };
}

function testKekSecret(): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = i;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const KEK_VERSION = 'GMAIL_KEK_V1';

function fakeGoogleClient(
  overrides: Partial<GoogleOAuthClient> = {},
  calls: string[] = [],
): GoogleOAuthClient {
  return {
    exchangeCode: async (): Promise<GoogleTokenExchangeResult> => {
      calls.push('exchangeCode');
      return { refreshToken: '1//fake-refresh-token', gmailEmail: 'owner@example.com' };
    },
    revokeToken: async () => {
      calls.push('revokeToken');
    },
    stopWatch: async () => {
      calls.push('stopWatch');
    },
    ...overrides,
  };
}

describe('PKCE helpers', () => {
  it('generateRandomToken produces a 43-char base64url string (RFC 7636 range, S256 challenge input)', () => {
    const token = generateRandomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('generateRandomToken is different on every call', () => {
    expect(generateRandomToken()).not.toBe(generateRandomToken());
  });

  it('computeCodeChallenge matches an independently computed SHA-256/base64url digest', async () => {
    const verifier = 'a-fixed-test-verifier-value';
    const challenge = await computeCodeChallenge(verifier);

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    let binary = '';
    for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
    const expected = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    expect(challenge).toBe(expected);
  });
});

describe('createOAuthFlow / consumeOAuthFlow', () => {
  it('CONSUMED: a flow created can be consumed once, returning the stored verifier', async () => {
    const { db } = await setup();
    await createOAuthFlow(db, { state: 'state-1', codeVerifier: 'verifier-1', now: FIXTURE_NOW });

    const result = await consumeOAuthFlow(db, {
      state: 'state-1',
      now: FIXTURE_NOW,
      ttlMs: 600_000,
    });
    expect(result).toEqual({ outcome: 'CONSUMED', codeVerifier: 'verifier-1' });
  });

  it(
    'proposal §3 named test: one-time consumption -- a second callback with the SAME state is ' +
      'rejected (NOT_FOUND), closing the replay/reuse gap',
    async () => {
      const { db } = await setup();
      await createOAuthFlow(db, { state: 'state-1', codeVerifier: 'verifier-1', now: FIXTURE_NOW });

      const first = await consumeOAuthFlow(db, {
        state: 'state-1',
        now: FIXTURE_NOW,
        ttlMs: 600_000,
      });
      expect(first.outcome).toBe('CONSUMED');

      const second = await consumeOAuthFlow(db, {
        state: 'state-1',
        now: FIXTURE_NOW,
        ttlMs: 600_000,
      });
      expect(second).toEqual({ outcome: 'NOT_FOUND' });
    },
  );

  it('NOT_FOUND: consuming a state that was never created', async () => {
    const { db } = await setup();
    const result = await consumeOAuthFlow(db, {
      state: 'never-created',
      now: FIXTURE_NOW,
      ttlMs: 600_000,
    });
    expect(result).toEqual({ outcome: 'NOT_FOUND' });
  });

  it('EXPIRED: consuming past the TTL window still deletes the row but reports EXPIRED', async () => {
    const { db } = await setup();
    await createOAuthFlow(db, { state: 'state-1', codeVerifier: 'verifier-1', now: FIXTURE_NOW });

    const farLater = new Date(Date.parse(FIXTURE_NOW) + 700_000).toISOString();
    const result = await consumeOAuthFlow(db, { state: 'state-1', now: farLater, ttlMs: 600_000 });
    expect(result).toEqual({ outcome: 'EXPIRED' });

    // The row was consumed (deleted) as a side effect even though it was expired -- a third
    // attempt finds nothing at all, not EXPIRED again.
    const again = await consumeOAuthFlow(db, { state: 'state-1', now: farLater, ttlMs: 600_000 });
    expect(again).toEqual({ outcome: 'NOT_FOUND' });
  });

  it(
    'functional-test review follow-up (MINOR): the TTL boundary is exact -- consuming AT exactly ' +
      'ttlMs elapsed still succeeds (CONSUMED), proving the check is `>` not an off-by-one `>=` ' +
      'that would reject a callback arriving right at the boundary',
    async () => {
      const { db } = await setup();
      await createOAuthFlow(db, { state: 'state-1', codeVerifier: 'verifier-1', now: FIXTURE_NOW });

      const exactlyAtTtl = new Date(Date.parse(FIXTURE_NOW) + 600_000).toISOString();
      const result = await consumeOAuthFlow(db, {
        state: 'state-1',
        now: exactlyAtTtl,
        ttlMs: 600_000,
      });
      expect(result).toEqual({ outcome: 'CONSUMED', codeVerifier: 'verifier-1' });
    },
  );

  it(
    'functional-test review follow-up (MINOR): one-time consumption physically deletes the row -- ' +
      "checked via an independent raw SELECT, not by trusting consumeOAuthFlow's own report of " +
      'its side effect a second time',
    async () => {
      const { db } = await setup();
      await createOAuthFlow(db, { state: 'state-1', codeVerifier: 'verifier-1', now: FIXTURE_NOW });
      await consumeOAuthFlow(db, { state: 'state-1', now: FIXTURE_NOW, ttlMs: 600_000 });

      const row = await db
        .prepare('SELECT 1 FROM oauth_flows WHERE state = ?')
        .bind('state-1')
        .first();
      expect(row).toBeNull();
    },
  );
});

describe('connectGmailAccount', () => {
  it('CONNECTED: exchanges the code and persists an encrypted, decryptable refresh token', async () => {
    const { db, accounts, kek } = await setup();
    const client = fakeGoogleClient();

    const result = await connectGmailAccount(db, kek, client, {
      sourceAccountId: accounts.gmailAccountId,
      code: 'auth-code',
      codeVerifier: 'verifier',
      collectionMode: 'PUSH',
      kekVersion: KEK_VERSION,
      now: FIXTURE_NOW,
    });
    expect(result).toEqual({ outcome: 'CONNECTED' });

    const row = await db
      .prepare(
        'SELECT gmail_email, encrypted_refresh_token, refresh_token_iv, collection_mode FROM gmail_connections WHERE source_account_id = ?',
      )
      .bind(accounts.gmailAccountId)
      .first<{
        gmail_email: string;
        encrypted_refresh_token: string;
        refresh_token_iv: string;
        collection_mode: string;
      }>();
    expect(row?.gmail_email).toBe('owner@example.com');
    expect(row?.collection_mode).toBe('PUSH');

    const decrypted = await decryptRefreshToken(
      kek,
      { ciphertext: row!.encrypted_refresh_token, iv: row!.refresh_token_iv },
      { gmailAccountId: accounts.gmailAccountId, kekVersion: KEK_VERSION },
    );
    expect(decrypted).toBe('1//fake-refresh-token');
  });

  it(
    'proposal §3 named test: reconnect yields a refresh token -- a SECOND connectGmailAccount ' +
      'call for the same account (simulating prompt=consent on reconnect) updates the existing row ' +
      'rather than conflicting on the primary key',
    async () => {
      const { db, accounts, kek } = await setup();

      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-1',
        codeVerifier: 'verifier-1',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const reconnectClient = fakeGoogleClient({
        exchangeCode: async () => ({
          refreshToken: '1//second-refresh-token',
          gmailEmail: 'owner@example.com',
        }),
      });
      const later = new Date(Date.parse(FIXTURE_NOW) + 1000).toISOString();
      const result = await connectGmailAccount(db, kek, reconnectClient, {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-2',
        codeVerifier: 'verifier-2',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: later,
      });
      expect(result).toEqual({ outcome: 'CONNECTED' });

      const rows = await db
        .prepare(
          'SELECT encrypted_refresh_token, refresh_token_iv FROM gmail_connections WHERE source_account_id = ?',
        )
        .bind(accounts.gmailAccountId)
        .all<{ encrypted_refresh_token: string; refresh_token_iv: string }>();
      expect(rows.results.length).toBe(1);

      const decrypted = await decryptRefreshToken(
        kek,
        {
          ciphertext: rows.results[0]!.encrypted_refresh_token,
          iv: rows.results[0]!.refresh_token_iv,
        },
        { gmailAccountId: accounts.gmailAccountId, kekVersion: KEK_VERSION },
      );
      expect(decrypted).toBe('1//second-refresh-token');
    },
  );

  it(
    'NO_REFRESH_TOKEN: Google omitting a refresh token fails closed -- an EXISTING connection row ' +
      'is never overwritten with a token-less state',
    async () => {
      const { db, accounts, kek } = await setup();

      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-1',
        codeVerifier: 'verifier-1',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const noTokenClient = fakeGoogleClient({
        exchangeCode: async () => ({ refreshToken: null, gmailEmail: 'owner@example.com' }),
      });
      const result = await connectGmailAccount(db, kek, noTokenClient, {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-2',
        codeVerifier: 'verifier-2',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });
      expect(result).toEqual({ outcome: 'NO_REFRESH_TOKEN' });

      const row = await db
        .prepare(
          'SELECT encrypted_refresh_token, refresh_token_iv FROM gmail_connections WHERE source_account_id = ?',
        )
        .bind(accounts.gmailAccountId)
        .first<{ encrypted_refresh_token: string; refresh_token_iv: string }>();

      const decrypted = await decryptRefreshToken(
        kek,
        { ciphertext: row!.encrypted_refresh_token, iv: row!.refresh_token_iv },
        { gmailAccountId: accounts.gmailAccountId, kekVersion: KEK_VERSION },
      );
      expect(decrypted).toBe('1//fake-refresh-token');
    },
  );

  it(
    'security review follow-up (MINOR): an empty-string refresh token is ALSO treated as ' +
      '"no token" (fail-closed), not just a literal null -- guards against a plausible future ' +
      "GoogleOAuthClient implementation mapping Google's missing refresh_token field to '' " +
      'instead of null',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-1',
        codeVerifier: 'verifier-1',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const emptyStringClient = fakeGoogleClient({
        exchangeCode: async () => ({ refreshToken: '', gmailEmail: 'owner@example.com' }),
      });
      const result = await connectGmailAccount(db, kek, emptyStringClient, {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-2',
        codeVerifier: 'verifier-2',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });
      expect(result).toEqual({ outcome: 'NO_REFRESH_TOKEN' });
    },
  );

  it(
    'NO_REFRESH_TOKEN releases the gmail_oauth_lifecycle lock it acquired -- a follow-up connect ' +
      'attempt is not left stuck behind an abandoned lock',
    async () => {
      const { db, accounts, kek } = await setup();
      const noTokenClient = fakeGoogleClient({
        exchangeCode: async () => ({ refreshToken: null, gmailEmail: 'owner@example.com' }),
      });
      const first = await connectGmailAccount(db, kek, noTokenClient, {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-1',
        codeVerifier: 'verifier-1',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });
      expect(first).toEqual({ outcome: 'NO_REFRESH_TOKEN' });

      const retry = await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-2',
        codeVerifier: 'verifier-2',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });
      expect(retry).toEqual({ outcome: 'CONNECTED' });
    },
  );

  it(
    'a thrown exchangeCode() failure releases the gmail_oauth_lifecycle lock -- exchangeCode() ' +
      'never mutates anything at Google (unlike stopWatch/revokeToken), so releasing immediately ' +
      'on ANY failure here is always safe, not merely a specific pre-Google case',
    async () => {
      const { db, accounts, kek } = await setup();
      const exchangeFails = new Error('google exchange transport failure');
      const failingClient = fakeGoogleClient({
        exchangeCode: async () => {
          throw exchangeFails;
        },
      });

      await expect(
        connectGmailAccount(db, kek, failingClient, {
          sourceAccountId: accounts.gmailAccountId,
          code: 'auth-code-1',
          codeVerifier: 'verifier-1',
          collectionMode: 'PUSH',
          kekVersion: KEK_VERSION,
          now: FIXTURE_NOW,
        }),
      ).rejects.toThrow(exchangeFails);

      const retry = await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-2',
        codeVerifier: 'verifier-2',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });
      expect(retry).toEqual({ outcome: 'CONNECTED' });
    },
  );

  it(
    'GPT-PM round-8 MAJOR #1: connectGmailAccount acquires the gmail_oauth_lifecycle lock BEFORE ' +
      'calling exchangeCode(), so a disconnectGmailAccount attempted WHILE connect is mid-' +
      'exchangeCode() is refused (DISCONNECT_IN_PROGRESS) rather than being able to run to ' +
      'completion and delete gmail_connections out from under the connect that is about to ' +
      'persist a fresh credential -- the exact failure scenario GPT-PM demonstrated: the OLD ' +
      "design's only guard lived on gmail_connections itself and was bypassable once that row " +
      'was deleted mid-flight',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-1',
        codeVerifier: 'verifier-1',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      let disconnectResult: DisconnectGmailAccountResult | null = null;
      const reconnectClient = fakeGoogleClient({
        exchangeCode: async () => {
          disconnectResult = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
            sourceAccountId: accounts.gmailAccountId,
            now: FIXTURE_NOW,
            clock: () => FIXTURE_NOW,
          });
          return { refreshToken: '1//reconnect-token', gmailEmail: 'owner@example.com' };
        },
      });

      const reconnectResult = await connectGmailAccount(db, kek, reconnectClient, {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-2',
        codeVerifier: 'verifier-2',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      expect(disconnectResult).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });
      expect(reconnectResult).toEqual({ outcome: 'CONNECTED' });

      const row = await db
        .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
        .bind(accounts.gmailAccountId)
        .first();
      expect(row).not.toBeNull();
    },
  );

  it(
    'GPT-PM round-8 MAJOR #2: a reconnect immediately after a successful disconnect is refused ' +
      '(REVOKE_PROPAGATION_BUFFER_MS not yet elapsed since revoke_settled_at), but a reconnect ' +
      'long enough afterward succeeds -- Google documents that revocation can continue ' +
      'propagating after a successful response, so a bare cleared lock is not by itself proof it ' +
      'is safe to reopen',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-1',
        codeVerifier: 'verifier-1',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const disconnectResult = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => FIXTURE_NOW,
      });
      expect(disconnectResult).toEqual({ outcome: 'DISCONNECTED' });

      const tooSoon = await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-2',
        codeVerifier: 'verifier-2',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });
      expect(tooSoon).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });

      const wayLater = new Date(Date.parse(FIXTURE_NOW) + 60 * 60_000).toISOString();
      const afterBuffer = await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-3',
        codeVerifier: 'verifier-3',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: wayLater,
      });
      expect(afterBuffer).toEqual({ outcome: 'CONNECTED' });
    },
  );
});

describe('disconnectGmailAccount', () => {
  it('DISCONNECTED: deletes the connection row and cancels in-flight OAuth flows', async () => {
    const { db, accounts, kek } = await setup();
    await connectGmailAccount(db, kek, fakeGoogleClient(), {
      sourceAccountId: accounts.gmailAccountId,
      code: 'auth-code',
      codeVerifier: 'verifier',
      collectionMode: 'PUSH',
      kekVersion: KEK_VERSION,
      now: FIXTURE_NOW,
    });
    await createOAuthFlow(db, { state: 'stray-flow', codeVerifier: 'v', now: FIXTURE_NOW });

    const result = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
      sourceAccountId: accounts.gmailAccountId,
      now: FIXTURE_NOW,
      clock: () => FIXTURE_NOW,
    });
    expect(result).toEqual({ outcome: 'DISCONNECTED' });

    const row = await db
      .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
      .bind(accounts.gmailAccountId)
      .first();
    expect(row).toBeNull();

    const flows = await db.prepare('SELECT 1 FROM oauth_flows').all();
    expect(flows.results.length).toBe(0);
  });

  it('NOT_CONNECTED: disconnecting an account with no connection row is a no-op that touches Google nothing', async () => {
    const { db, accounts, kek } = await setup();
    const calls: string[] = [];
    const client = fakeGoogleClient({}, calls);

    const result = await disconnectGmailAccount(db, kek, client, {
      sourceAccountId: accounts.gmailAccountId,
      now: FIXTURE_NOW,
      clock: () => FIXTURE_NOW,
    });
    expect(result).toEqual({ outcome: 'NOT_CONNECTED' });
    expect(calls).toEqual([]);
  });

  it(
    'proposal §3 named test: disconnect ordering -- stopWatch, then revoke (called with the ' +
      'correctly DECRYPTED token) while the local row still exists, and only THEN is the row ' +
      'deleted',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const calls: string[] = [];
      let rowExistedDuringRevoke: boolean | null = null;
      let revokedWithToken: string | null = null;
      const client = fakeGoogleClient(
        {
          revokeToken: async (refreshToken: string) => {
            calls.push('revokeToken');
            revokedWithToken = refreshToken;
            const row = await db
              .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
              .bind(accounts.gmailAccountId)
              .first();
            rowExistedDuringRevoke = row !== null;
          },
          stopWatch: async () => {
            calls.push('stopWatch');
          },
        },
        calls,
      );

      await disconnectGmailAccount(db, kek, client, {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => FIXTURE_NOW,
      });

      expect(calls).toEqual(['stopWatch', 'revokeToken']);
      expect(rowExistedDuringRevoke).toBe(true);
      expect(revokedWithToken).toBe('1//fake-refresh-token');

      const row = await db
        .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
        .bind(accounts.gmailAccountId)
        .first();
      expect(row).toBeNull();
    },
  );

  it(
    'GPT-PM round-7 MAJOR #2: revokeToken throwing raises DisconnectAmbiguousExternalCallError ' +
      '(wrapping the original error via .cause) rather than the raw error or being silently ' +
      'swallowed -- the connection row and oauth_flows are left completely untouched, AND the ' +
      'lifecycle lock is deliberately NOT released, since whether Google actually processed the ' +
      'revoke before this error surfaced locally is unknown',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });
      await createOAuthFlow(db, { state: 'stray-flow', codeVerifier: 'v', now: FIXTURE_NOW });

      const revokeFails = new Error('google unavailable');
      const failingClient = fakeGoogleClient({
        revokeToken: async () => {
          throw revokeFails;
        },
      });

      let caught: unknown = null;
      try {
        await disconnectGmailAccount(db, kek, failingClient, {
          sourceAccountId: accounts.gmailAccountId,
          now: FIXTURE_NOW,
          clock: () => FIXTURE_NOW,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DisconnectAmbiguousExternalCallError);
      expect((caught as DisconnectAmbiguousExternalCallError).cause).toBe(revokeFails);

      const row = await db
        .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
        .bind(accounts.gmailAccountId)
        .first();
      expect(row).not.toBeNull();

      const flow = await db
        .prepare('SELECT 1 FROM oauth_flows WHERE state = ?')
        .bind('stray-flow')
        .first();
      expect(flow).not.toBeNull();

      // The lock was NOT released: neither a retried disconnect nor a reconnect may proceed.
      const retryDisconnect = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => FIXTURE_NOW,
      });
      expect(retryDisconnect).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });

      const reconnectAttempt = await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-2',
        codeVerifier: 'verifier-2',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });
      expect(reconnectAttempt).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });
    },
  );

  it(
    'GPT-PM round-8 MAJOR #3: stopWatch throwing ALSO raises DisconnectAmbiguousExternalCallError ' +
      '(not released) exactly like an ambiguous revokeToken failure -- stopWatch (Gmail users.stop) ' +
      'is itself a remote, mutating Google call, so a transport failure after the request may have ' +
      'been sent is exactly as ambiguous as a revokeToken failure, not provably local the way round ' +
      "7's design incorrectly treated it",
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const stopWatchFails = new Error('stopWatch transport failure');
      const failingClient = fakeGoogleClient({
        stopWatch: async () => {
          throw stopWatchFails;
        },
      });

      let caught: unknown = null;
      try {
        await disconnectGmailAccount(db, kek, failingClient, {
          sourceAccountId: accounts.gmailAccountId,
          now: FIXTURE_NOW,
          clock: () => FIXTURE_NOW,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DisconnectAmbiguousExternalCallError);
      expect((caught as DisconnectAmbiguousExternalCallError).cause).toBe(stopWatchFails);

      const row = await db
        .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
        .bind(accounts.gmailAccountId)
        .first();
      expect(row).not.toBeNull();

      const retryDisconnect = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => FIXTURE_NOW,
      });
      expect(retryDisconnect).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });

      const reconnectAttempt = await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-2',
        codeVerifier: 'verifier-2',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });
      expect(reconnectAttempt).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });
    },
  );

  it(
    'GPT-PM round-8 MAJOR #3, post-stopWatch failure path: a LOCAL decrypt failure AFTER ' +
      "stopWatch has already resolved (externalPhase 'stop-settled') DOES release the lock " +
      "immediately -- revokeToken was never invoked this attempt, so Google's revoke state is " +
      'genuinely unchanged, unlike an ambiguous stopWatch/revokeToken rejection',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      // Corrupt the stored IV so decryptRefreshToken's AES-GCM authentication check fails --
      // stopWatch (called first, before decrypt) still resolves normally.
      await db
        .prepare('UPDATE gmail_connections SET refresh_token_iv = ? WHERE source_account_id = ?')
        .bind('AAAAAAAAAAAAAAAA', accounts.gmailAccountId)
        .run();

      await expect(
        disconnectGmailAccount(db, kek, fakeGoogleClient(), {
          sourceAccountId: accounts.gmailAccountId,
          now: FIXTURE_NOW,
          clock: () => FIXTURE_NOW,
        }),
      ).rejects.toThrow();

      // The lock WAS released (this failure is provably local/pre-Google) -- clean up the
      // corrupted row directly, then confirm a fresh connect is no longer refused.
      await db
        .prepare('DELETE FROM gmail_connections WHERE source_account_id = ?')
        .bind(accounts.gmailAccountId)
        .run();
      const reconnectAttempt = await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-2',
        codeVerifier: 'verifier-2',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });
      expect(reconnectAttempt).toEqual({ outcome: 'CONNECTED' });
    },
  );

  // NOTE (round-9, functional-test-reviewer MINOR): this test and 'GPT-PM round 5/6 MAJOR' below
  // look near-identical (both race a reconnect against disconnect's own in-flight revokeToken()) --
  // intentionally preserved as two separate tests, not merged, since they document two DIFFERENT
  // historical GPT-PM findings (rounds 2-3's original discovery vs. rounds 5-6's fix to what
  // "cleared" means) that happen to share the same reproduction shape under the current design.
  it(
    'GPT-PM round-2/round-3 MAJOR (superseding round-1 MAJOR #1): a reconnect attempted DURING ' +
      "disconnect's own revokeToken call is refused with DISCONNECT_IN_PROGRESS -- Google's " +
      'revocation is project-wide (developers.google.com/identity/protocols/oauth2/native-app), so ' +
      'a credential issued while an old token is being revoked can be invalidated by that SAME ' +
      'revoke; the disconnect lease refuses the write outright instead of letting it be issued and ' +
      'then silently invalidated underneath local state',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-1',
        codeVerifier: 'verifier-1',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      // Simulate the race: a reconnect lands while disconnect is mid-flight, inside its own
      // revokeToken call -- strictly after disconnect's own lease acquisition on the OLD row.
      let reconnectResult: ConnectGmailAccountResult | null = null;
      const client = fakeGoogleClient({
        revokeToken: async () => {
          reconnectResult = await connectGmailAccount(
            db,
            kek,
            fakeGoogleClient({
              exchangeCode: async () => ({
                refreshToken: '1//concurrent-reconnect-token',
                gmailEmail: 'owner@example.com',
              }),
            }),
            {
              sourceAccountId: accounts.gmailAccountId,
              code: 'auth-code-2',
              codeVerifier: 'verifier-2',
              collectionMode: 'PUSH',
              kekVersion: KEK_VERSION,
              now: FIXTURE_NOW,
            },
          );
        },
      });

      const result = await disconnectGmailAccount(db, kek, client, {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => FIXTURE_NOW,
      });

      expect(reconnectResult).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });
      expect(result).toEqual({ outcome: 'DISCONNECTED' });

      const row = await db
        .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
        .bind(accounts.gmailAccountId)
        .first();
      expect(row).toBeNull();
    },
  );

  it(
    'DISCONNECT_IN_PROGRESS: a second disconnectGmailAccount call for the same account while the ' +
      'first still holds an unexpired lease is refused rather than double-revoking or ' +
      'double-deleting',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      let secondResult: DisconnectGmailAccountResult | null = null;
      const client = fakeGoogleClient({
        revokeToken: async () => {
          secondResult = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
            sourceAccountId: accounts.gmailAccountId,
            now: FIXTURE_NOW,
            clock: () => FIXTURE_NOW,
          });
        },
      });

      const firstResult = await disconnectGmailAccount(db, kek, client, {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => FIXTURE_NOW,
      });

      expect(secondResult).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });
      expect(firstResult).toEqual({ outcome: 'DISCONNECTED' });
    },
  );

  it(
    'GPT-PM round 5/6 MAJOR (superseding rounds 4/5), preserved under the round-8 lock design: a ' +
      "reconnect is refused for as long as disconnect's own gmail_oauth_lifecycle lock is genuinely " +
      'held, proving reconnect eligibility depends on the lock actually being CLEARED, never on any ' +
      'elapsed-time signal -- the acquisition guard reads only lock_token IS NULL, so there is no ' +
      'stored expiry left to manipulate the way rounds 4 and 5 each incorrectly relied on one',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      let reconnectResult: ConnectGmailAccountResult | null = null;
      const client = fakeGoogleClient({
        revokeToken: async () => {
          reconnectResult = await connectGmailAccount(
            db,
            kek,
            fakeGoogleClient({
              exchangeCode: async () => ({
                refreshToken: '1//concurrent-reconnect-token',
                gmailEmail: 'owner@example.com',
              }),
            }),
            {
              sourceAccountId: accounts.gmailAccountId,
              code: 'auth-code-2',
              codeVerifier: 'verifier-2',
              collectionMode: 'PUSH',
              kekVersion: KEK_VERSION,
              now: FIXTURE_NOW,
            },
          );
        },
      });

      const result = await disconnectGmailAccount(db, kek, client, {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => FIXTURE_NOW,
      });

      expect(reconnectResult).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });
      expect(result).toEqual({ outcome: 'DISCONNECTED' });
    },
  );

  it(
    'GPT-PM round-7 MAJOR #1, preserved under the round-8 lock design: an abandoned lock (the ' +
      'shape a disconnect that crashed outright, never reaching its own catch block, would leave ' +
      "behind on gmail_oauth_lifecycle) is a DELIBERATE dead end for this module's own public API " +
      '-- neither a reconnect NOR a fresh disconnectGmailAccount call may take it over, because no ' +
      "client-side signal can prove the original attempt's external call actually finished",
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      // Simulate an abandoned lock directly at the schema level -- the exact shape a crashed
      // disconnectGmailAccount call would leave behind on gmail_oauth_lifecycle.
      // The row already exists (connectGmailAccount above created and then released it), so this
      // seeds the abandoned lock via UPDATE, not INSERT.
      await db
        .prepare(
          `UPDATE gmail_oauth_lifecycle
           SET lock_token = ?, lock_kind = 'DISCONNECT', lock_acquired_at = ?, source_account_id = ?
           WHERE source = 'gmail'`,
        )
        .bind('abandoned-lock', FIXTURE_NOW, accounts.gmailAccountId)
        .run();

      const reconnectAttempt = await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-2',
        codeVerifier: 'verifier-2',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });
      expect(reconnectAttempt).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });

      const disconnectTakeoverAttempt = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => FIXTURE_NOW,
      });
      expect(disconnectTakeoverAttempt).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });

      // Still stuck: the abandoned lock token is still exactly what was seeded, proving neither
      // attempt above silently cleared or replaced it.
      const lifecycle = await db
        .prepare("SELECT lock_token FROM gmail_oauth_lifecycle WHERE source = 'gmail'")
        .first<{ lock_token: string }>();
      expect(lifecycle?.lock_token).toBe('abandoned-lock');
    },
  );

  it(
    'GPT-PM round-1 MAJOR #2: the connection delete, the oauth_flows clear, and the lifecycle ' +
      'lock release/revoke_settled_at write are now THREE statements in ONE atomic db.batch() -- ' +
      'when the batch itself fails, NONE of them take effect, so a retry is never stuck seeing a ' +
      'half-cleaned-up state. Also GPT-PM round-7 MAJOR #2 + round-8 MAJOR #2, post-settlement ' +
      'failure path: since revokeToken already resolved successfully before the batch threw, the ' +
      "catch block's OWN separate release records revoke_settled_at (Google's side is confirmed " +
      'settled) -- an immediate reconnect is still refused by the propagation buffer, but a ' +
      'disconnect retry (unaffected by that buffer) succeeds',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });
      await createOAuthFlow(db, { state: 'stray-flow', codeVerifier: 'v', now: FIXTURE_NOW });

      const batchFailure = new Error('D1 batch transport failure');
      const failingBatchDb: D1Database = {
        prepare: (sql: string) => db.prepare(sql),
        batch: async () => {
          throw batchFailure;
        },
      } as unknown as D1Database;

      await expect(
        disconnectGmailAccount(failingBatchDb, kek, fakeGoogleClient(), {
          sourceAccountId: accounts.gmailAccountId,
          now: FIXTURE_NOW,
          clock: () => FIXTURE_NOW,
        }),
      ).rejects.toThrow(batchFailure);

      const row = await db
        .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
        .bind(accounts.gmailAccountId)
        .first();
      expect(row).not.toBeNull();

      const flow = await db
        .prepare('SELECT 1 FROM oauth_flows WHERE state = ?')
        .bind('stray-flow')
        .first();
      expect(flow).not.toBeNull();

      // The lock WAS released (revokeToken had already resolved) -- a disconnect retry against the
      // real db succeeds. Delete the leftover row first (it was only "not yet deleted" because the
      // batch failed, not because it is a fresh connection) so the retry has a clean row to act on.
      await db
        .prepare('DELETE FROM gmail_connections WHERE source_account_id = ?')
        .bind(accounts.gmailAccountId)
        .run();

      // But revoke_settled_at WAS recorded from the failed attempt -- an immediate reconnect is
      // still refused by the propagation buffer even though the lock itself is free.
      const immediateReconnect = await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-2',
        codeVerifier: 'verifier-2',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });
      expect(immediateReconnect).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });

      const retryResult = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => FIXTURE_NOW,
      });
      expect(retryResult).toEqual({ outcome: 'NOT_CONNECTED' });
    },
  );
});

describe('round-9 remediation (internal review: architect, database-reviewer, functional-test-reviewer)', () => {
  it(
    "functional-test-reviewer MAJOR: releaseLifecycleLock's CAS fence on lock_token is load-bearing " +
      "-- a release attempt whose own token no longer matches the row's CURRENT holder (a different " +
      "actor took over in between) does NOT clear that other, currently-legitimate holder's lock",
    async () => {
      const { db, accounts, kek } = await setup();
      const exchangeFails = new Error('transport failure');
      const failingClient = fakeGoogleClient({
        exchangeCode: async () => {
          // Simulate a different actor (e.g. a disconnect) taking over this account's lock in
          // between this call's own acquisition and its about-to-happen release attempt.
          await db
            .prepare(
              `UPDATE gmail_oauth_lifecycle
               SET lock_token = ?, lock_kind = 'DISCONNECT', lock_acquired_at = ?, source_account_id = ?
               WHERE source = 'gmail'`,
            )
            .bind('other-holder-token', FIXTURE_NOW, accounts.gmailAccountId)
            .run();
          throw exchangeFails;
        },
      });

      await expect(
        connectGmailAccount(db, kek, failingClient, {
          sourceAccountId: accounts.gmailAccountId,
          code: 'auth-code',
          codeVerifier: 'verifier',
          collectionMode: 'PUSH',
          kekVersion: KEK_VERSION,
          now: FIXTURE_NOW,
        }),
      ).rejects.toThrow(exchangeFails);

      const lifecycle = await db
        .prepare("SELECT lock_token, lock_kind FROM gmail_oauth_lifecycle WHERE source = 'gmail'")
        .first<{ lock_token: string; lock_kind: string }>();
      expect(lifecycle?.lock_token).toBe('other-holder-token');
      expect(lifecycle?.lock_kind).toBe('DISCONNECT');
    },
  );

  it(
    'functional-test-reviewer MINOR: the propagation buffer boundary -- a reconnect exactly ' +
      'REVOKE_PROPAGATION_BUFFER_MS (5 minutes) after revoke_settled_at is allowed, proving the ' +
      'guard is an inclusive <=, not a strict <',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-1',
        codeVerifier: 'verifier-1',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });
      await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => FIXTURE_NOW,
      });

      const exactlyAtBuffer = new Date(Date.parse(FIXTURE_NOW) + 5 * 60_000).toISOString();
      const result = await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-2',
        codeVerifier: 'verifier-2',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: exactlyAtBuffer,
      });
      expect(result).toEqual({ outcome: 'CONNECTED' });
    },
  );

  it(
    'architect MAJOR: an abandoned CONNECT-kind lock (crash debris -- exchangeCode() never mutates ' +
      'anything at Google, so unlike a DISCONNECT lock there is no ambiguity to protect) no longer ' +
      'permanently wedges disconnectGmailAccount -- refused until CONNECT_LOCK_STALE_MS (2 minutes) ' +
      'has elapsed since lock_acquired_at, then stealable',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      // Simulate crash debris: a CONNECT lock left behind with no release ever having run.
      await db
        .prepare(
          `UPDATE gmail_oauth_lifecycle
           SET lock_token = ?, lock_kind = 'CONNECT', lock_acquired_at = ?, source_account_id = ?
           WHERE source = 'gmail'`,
        )
        .bind('abandoned-connect-lock', FIXTURE_NOW, accounts.gmailAccountId)
        .run();

      const tooSoon = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        now: new Date(Date.parse(FIXTURE_NOW) + 60_000).toISOString(),
        clock: () => new Date(Date.parse(FIXTURE_NOW) + 60_000).toISOString(),
      });
      expect(tooSoon).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });

      const afterStale = new Date(Date.parse(FIXTURE_NOW) + 2 * 60_000 + 1).toISOString();
      const result = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        now: afterStale,
        clock: () => afterStale,
      });
      expect(result).toEqual({ outcome: 'DISCONNECTED' });
    },
  );

  it(
    'architect MAJOR: the never-delete invariant on gmail_oauth_lifecycle is enforced at the ' +
      'database level (a BEFORE DELETE trigger), not only in TypeScript prose',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      await expect(
        db.prepare("DELETE FROM gmail_oauth_lifecycle WHERE source = 'gmail'").run(),
      ).rejects.toThrow();
    },
  );

  it(
    "architect MAJOR #1 (this checkpoint's own reproduction): the credential write is fenced on " +
      'still holding the acquired lock at write time, not merely checked once at acquisition -- if ' +
      "a different actor takes the lock between acquisition and the final write (architect's own " +
      'scenario: the documented manual-recovery path clearing a wedged lock mid-exchangeCode()), ' +
      'connectGmailAccount throws ConnectLockLostBeforeWriteError instead of silently reporting ' +
      'CONNECTED without exclusivity, and never persists the credential',
    async () => {
      const { db, accounts, kek } = await setup();
      const client = fakeGoogleClient({
        exchangeCode: async () => {
          // Simulate the lock being reclaimed by someone else mid-flight -- our own lockToken is no
          // longer the current holder by the time this function's own write runs.
          await db
            .prepare(
              `UPDATE gmail_oauth_lifecycle
               SET lock_token = ?, lock_kind = 'DISCONNECT', lock_acquired_at = ?, source_account_id = ?
               WHERE source = 'gmail'`,
            )
            .bind('someone-else-token', FIXTURE_NOW, accounts.gmailAccountId)
            .run();
          return { refreshToken: '1//stolen-window-token', gmailEmail: 'owner@example.com' };
        },
      });

      await expect(
        connectGmailAccount(db, kek, client, {
          sourceAccountId: accounts.gmailAccountId,
          code: 'auth-code',
          codeVerifier: 'verifier',
          collectionMode: 'PUSH',
          kekVersion: KEK_VERSION,
          now: FIXTURE_NOW,
        }),
      ).rejects.toThrow(ConnectLockLostBeforeWriteError);

      const row = await db
        .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
        .bind(accounts.gmailAccountId)
        .first();
      expect(row).toBeNull();

      // The other holder's lock is untouched -- the catch block's own release attempt (with our
      // now-stale token) was a safe fenced no-op, not a clobber.
      const lifecycle = await db
        .prepare("SELECT lock_token FROM gmail_oauth_lifecycle WHERE source = 'gmail'")
        .first<{ lock_token: string }>();
      expect(lifecycle?.lock_token).toBe('someone-else-token');
    },
  );

  it(
    "architect MAJOR #3 (verified against Google's own primary OAuth documentation -- revocation " +
      'is project-wide, not scoped to one source_account_id): two DIFFERENT source_account_id rows ' +
      'can no longer hold a live connection to the SAME real Gmail address at once -- the UNIQUE ' +
      'index on gmail_connections(LOWER(gmail_email)) (migration 0005) refuses the second connect',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-1',
        codeVerifier: 'verifier-1',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const secondAccountId = 'acc-gmail-second';
      await db
        .prepare(
          'INSERT INTO source_accounts (source_account_id, user_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(secondAccountId, accounts.userId, 'gmail', FIXTURE_NOW, FIXTURE_NOW)
        .run();

      await expect(
        connectGmailAccount(db, kek, fakeGoogleClient(), {
          sourceAccountId: secondAccountId,
          code: 'auth-code-2',
          codeVerifier: 'verifier-2',
          collectionMode: 'PUSH',
          kekVersion: KEK_VERSION,
          now: FIXTURE_NOW,
        }),
      ).rejects.toThrow();

      const secondRow = await db
        .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
        .bind(secondAccountId)
        .first();
      expect(secondRow).toBeNull();
    },
  );

  it(
    'architect MAJOR (reconciliation primitives), updated for GPT-PM round-10 full-sweep MAJOR C: ' +
      'listWedgedGmailDisconnectLocks finds an ambiguous-failure-wedged account, and ' +
      'reconcileWedgedGmailDisconnectLock with REVOKE_CONFIRMED atomically finalizes the LOCAL ' +
      'disconnect too (connection delete + oauth_flows clear), not merely the lock, AND records ' +
      'revoke_settled_at -- no follow-up disconnectGmailAccount() call is needed to finish it',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const revokeFails = new Error('google unavailable');
      await expect(
        disconnectGmailAccount(
          db,
          kek,
          fakeGoogleClient({
            revokeToken: async () => {
              throw revokeFails;
            },
          }),
          { sourceAccountId: accounts.gmailAccountId, now: FIXTURE_NOW, clock: () => FIXTURE_NOW },
        ),
      ).rejects.toThrow(DisconnectAmbiguousExternalCallError);

      // Uses ONLY the exported primitives -- no raw SQL backdoor to fetch lock_token (round-10 fix,
      // GPT-PM full-sweep MAJOR: an earlier revision of listWedgedGmailDisconnectLocks omitted
      // lockToken, forcing exactly the raw-SQL step this test now proves is unnecessary).
      const wedged = await listWedgedGmailDisconnectLocks(db);
      expect(wedged).toHaveLength(1);
      expect(wedged[0]?.sourceAccountId).toBe(accounts.gmailAccountId);
      expect(wedged[0]?.outcomeUnknown).toBe('REVOKE_OUTCOME_UNKNOWN');

      const confirmedAt = new Date(Date.parse(FIXTURE_NOW) + 3600_000).toISOString();
      const reconcileResult = await reconcileWedgedGmailDisconnectLock(db, {
        sourceAccountId: accounts.gmailAccountId,
        lockToken: wedged[0]!.lockToken,
        now: confirmedAt,
        outcome: { phase: 'REVOKE_OUTCOME_UNKNOWN', confirmed: 'REVOKE_CONFIRMED' },
      });
      expect(reconcileResult).toBe('RECONCILED_DISCONNECT_FINALIZED');

      // The connection row is ALREADY gone -- reconciliation finished the disconnect itself (round-11
      // fix, GPT-PM round-10 full-sweep MAJOR C: the round-10 design left this as a dangling
      // obligation, proven by this very test having had to call disconnectGmailAccount() a second
      // time to actually remove it).
      const connectionRow = await db
        .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
        .bind(accounts.gmailAccountId)
        .first();
      expect(connectionRow).toBeNull();

      const secondDisconnect = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        now: confirmedAt,
        clock: () => confirmedAt,
      });
      expect(secondDisconnect).toEqual({ outcome: 'NOT_CONNECTED' });

      // ...but revoke_settled_at WAS recorded at the confirmation time, so an immediate reconnect
      // still respects the propagation buffer instead of the reconciliation silently bypassing it.
      const immediateReconnect = await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-2',
        codeVerifier: 'verifier-2',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: confirmedAt,
      });
      expect(immediateReconnect).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });
    },
  );

  it(
    'GPT-PM round-9 full-sweep MAJOR #1: the project-wide lock closes the cross-account race the ' +
      'per-source_account_id design could not -- a DIFFERENT account (B) attempting to connect ' +
      "while account A's disconnect is mid-revokeToken() is refused, even though A and B are " +
      'different source_account_id rows for different Gmail addresses',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-a',
        codeVerifier: 'verifier-a',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const secondAccountId = 'acc-gmail-second';
      await db
        .prepare(
          'INSERT INTO source_accounts (source_account_id, user_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(secondAccountId, accounts.userId, 'gmail', FIXTURE_NOW, FIXTURE_NOW)
        .run();

      let connectBResult: ConnectGmailAccountResult | null = null;
      const client = fakeGoogleClient({
        revokeToken: async () => {
          connectBResult = await connectGmailAccount(
            db,
            kek,
            fakeGoogleClient({
              exchangeCode: async () => ({
                refreshToken: '1//account-b-token',
                gmailEmail: 'other@example.com',
              }),
            }),
            {
              sourceAccountId: secondAccountId,
              code: 'auth-code-b',
              codeVerifier: 'verifier-b',
              collectionMode: 'PUSH',
              kekVersion: KEK_VERSION,
              now: FIXTURE_NOW,
            },
          );
        },
      });

      const disconnectAResult = await disconnectGmailAccount(db, kek, client, {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => FIXTURE_NOW,
      });

      expect(connectBResult).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });
      expect(disconnectAResult).toEqual({ outcome: 'DISCONNECTED' });

      const bRow = await db
        .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
        .bind(secondAccountId)
        .first();
      expect(bRow).toBeNull();
    },
  );

  it(
    "GPT-PM round-9 full-sweep MAJOR #2: revoke_settled_at reflects opts.clock()'s post-revokeToken() " +
      "reading, not this call's entry-time now -- a slow stopWatch+revokeToken no longer silently " +
      'shrinks REVOKE_PROPAGATION_BUFFER_MS',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      // stopWatch + revokeToken together take 4 real minutes, simulated via clock() returning a
      // reading 4 minutes after this call's own entry-time `now`.
      const settledAt = new Date(Date.parse(FIXTURE_NOW) + 4 * 60_000).toISOString();
      await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => settledAt,
      });

      // 5 minutes after ENTRY time, but only 1 minute after the REAL settlement -- if
      // revoke_settled_at had wrongly been recorded as entry-time `now`, this would already be
      // eligible; it must still be refused.
      const fiveMinAfterEntry = new Date(Date.parse(FIXTURE_NOW) + 5 * 60_000).toISOString();
      const tooSoon = await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-2',
        codeVerifier: 'verifier-2',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: fiveMinAfterEntry,
      });
      expect(tooSoon).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });

      // 5 minutes after the REAL settlement -- now eligible.
      const fiveMinAfterSettle = new Date(Date.parse(settledAt) + 5 * 60_000).toISOString();
      const afterBuffer = await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-3',
        codeVerifier: 'verifier-3',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: fiveMinAfterSettle,
      });
      expect(afterBuffer).toEqual({ outcome: 'CONNECTED' });
    },
  );

  it(
    'GPT-PM round-9 full-sweep MAJOR #3: reconcileWedgedGmailDisconnectLock reports STALE_LOCK ' +
      "(not a silent success) when the supplied lockToken no longer matches the row's current " +
      'holder, instead of returning void unconditionally',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const revokeFails = new Error('google unavailable');
      await expect(
        disconnectGmailAccount(
          db,
          kek,
          fakeGoogleClient({
            revokeToken: async () => {
              throw revokeFails;
            },
          }),
          { sourceAccountId: accounts.gmailAccountId, now: FIXTURE_NOW, clock: () => FIXTURE_NOW },
        ),
      ).rejects.toThrow(DisconnectAmbiguousExternalCallError);

      const result = await reconcileWedgedGmailDisconnectLock(db, {
        sourceAccountId: accounts.gmailAccountId,
        lockToken: 'definitely-not-the-real-token',
        now: FIXTURE_NOW,
        outcome: { phase: 'REVOKE_OUTCOME_UNKNOWN', confirmed: 'REVOKE_CONFIRMED' },
      });
      expect(result).toBe('STALE_LOCK');

      // Still wedged -- the bogus reconcile attempt did not clear it, and did NOT delete the
      // connection row either (the REVOKE_CONFIRMED atomic-finalize path's own connection delete is
      // fenced on the same bogus lock_token, so it is a no-op too -- round-11 addition).
      const stillWedged = await listWedgedGmailDisconnectLocks(db);
      expect(stillWedged).toHaveLength(1);
      const connectionRow = await db
        .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
        .bind(accounts.gmailAccountId)
        .first();
      expect(connectionRow).not.toBeNull();
    },
  );

  it(
    'GPT-PM round-9 full-sweep MAJOR #4: listWedgedGmailDisconnectLocks does NOT list a disconnect ' +
      'that is still legitimately executing (holds the DISCONNECT lock but has not hit the ' +
      "ambiguous-failure catch branch) -- lock_kind = 'DISCONNECT' alone cannot distinguish that " +
      'from a genuinely wedged account; recovery_state can',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      let sawWhileInFlight: unknown[] | null = null;
      const client = fakeGoogleClient({
        stopWatch: async () => {
          // Still mid-flight, holding the DISCONNECT lock, no error yet -- must not appear here.
          sawWhileInFlight = await listWedgedGmailDisconnectLocks(db);
        },
      });

      await disconnectGmailAccount(db, kek, client, {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => FIXTURE_NOW,
      });

      expect(sawWhileInFlight).toEqual([]);
    },
  );

  it(
    'GPT-PM round-9 full-sweep MAJOR #5: a purely local D1 read failure (the credential SELECT) is ' +
      'now inside the protected release path -- no Google call was ever attempted, so the lock ' +
      'releases immediately instead of wedging the account forever',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const selectFails = new Error('transient D1 read failure');
      const flakyDb: D1Database = {
        prepare: (sql: string) => {
          if (sql.includes('SELECT encrypted_refresh_token')) {
            return {
              bind: () => ({
                first: async () => {
                  throw selectFails;
                },
              }),
            };
          }
          return db.prepare(sql);
        },
        batch: (statements: unknown) =>
          (db as unknown as { batch: (s: unknown) => unknown }).batch(statements),
      } as unknown as D1Database;

      await expect(
        disconnectGmailAccount(flakyDb, kek, fakeGoogleClient(), {
          sourceAccountId: accounts.gmailAccountId,
          now: FIXTURE_NOW,
          clock: () => FIXTURE_NOW,
        }),
      ).rejects.toThrow(selectFails);

      // The lock WAS released (this failure never touched Google) -- an immediate retry against
      // the real db succeeds.
      const retry = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => FIXTURE_NOW,
      });
      expect(retry).toEqual({ outcome: 'DISCONNECTED' });
    },
  );

  it(
    'GPT-PM round-10 full-sweep MAJOR A (acquisition-write fault injection, connectGmailAccount): ' +
      'a thrown (not merely zero-rows) lock-acquisition .run() that actually landed at D1 before ' +
      'throwing locally is detected and released, rather than leaving the project-wide singleton ' +
      'wedged before exchangeCode() was ever even called',
    async () => {
      const { db, accounts, kek } = await setup();

      const acquireFails = new Error('transient D1 write error');
      let interceptedRun = false;
      const flakyDb: D1Database = {
        prepare: (sql: string) => {
          if (sql.includes("lock_kind = 'CONNECT'")) {
            return {
              bind: (...args: unknown[]) => ({
                run: async () => {
                  interceptedRun = true;
                  // Simulate: the write genuinely landed at D1, but the response was lost locally.
                  await db
                    .prepare(sql)
                    .bind(...args)
                    .run();
                  throw acquireFails;
                },
              }),
            };
          }
          return db.prepare(sql);
        },
        batch: (statements: unknown) =>
          (db as unknown as { batch: (s: unknown) => unknown }).batch(statements),
      } as unknown as D1Database;

      await expect(
        connectGmailAccount(flakyDb, kek, fakeGoogleClient(), {
          sourceAccountId: accounts.gmailAccountId,
          code: 'auth-code',
          codeVerifier: 'verifier',
          collectionMode: 'PUSH',
          kekVersion: KEK_VERSION,
          now: FIXTURE_NOW,
        }),
      ).rejects.toThrow(acquireFails);
      expect(interceptedRun).toBe(true);

      // No Google call was ever started (exchangeCode() is only reached AFTER acquisition) --
      // runAcquisitionWrite must have detected this call's own lockToken became the holder despite
      // the thrown error, and released it, so an immediate retry against the real db succeeds.
      const retry = await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-retry',
        codeVerifier: 'verifier-retry',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });
      expect(retry).toEqual({ outcome: 'CONNECTED' });
    },
  );

  it(
    'GPT-PM round-10 full-sweep MAJOR A (acquisition-write fault injection, disconnectGmailAccount): ' +
      'the same acquisition-write failure/release path, exercised on the DISCONNECT-kind acquisition',
    async () => {
      const { db, accounts, kek } = await setup();

      const acquireFails = new Error('transient D1 write error');
      let interceptedRun = false;
      const flakyDb: D1Database = {
        prepare: (sql: string) => {
          if (sql.includes("lock_kind = 'DISCONNECT'")) {
            return {
              bind: (...args: unknown[]) => ({
                run: async () => {
                  interceptedRun = true;
                  await db
                    .prepare(sql)
                    .bind(...args)
                    .run();
                  throw acquireFails;
                },
              }),
            };
          }
          return db.prepare(sql);
        },
        batch: (statements: unknown) =>
          (db as unknown as { batch: (s: unknown) => unknown }).batch(statements),
      } as unknown as D1Database;

      await expect(
        disconnectGmailAccount(flakyDb, kek, fakeGoogleClient(), {
          sourceAccountId: accounts.gmailAccountId,
          now: FIXTURE_NOW,
          clock: () => FIXTURE_NOW,
        }),
      ).rejects.toThrow(acquireFails);
      expect(interceptedRun).toBe(true);

      const retry = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => FIXTURE_NOW,
      });
      expect(retry).toEqual({ outcome: 'NOT_CONNECTED' });
    },
  );

  it(
    'GPT-PM round-10 full-sweep MAJOR A (recovery_state marker-write fault injection): when the ' +
      "ambiguous-catch branch's OWN write (persisting recovery_state) itself fails, the original " +
      'ambiguity is never silently lost or masked -- a distinct DisconnectRecoveryMarkerWriteFailedError ' +
      'is thrown instead, carrying the account/token/phase needed to force-recover the lock directly',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const markerWriteFails = new Error('transient D1 write error on the recovery_state marker');
      const flakyDb: D1Database = {
        prepare: (sql: string) => {
          if (sql.includes('SET recovery_state = ?')) {
            return {
              bind: () => ({
                run: async () => {
                  throw markerWriteFails;
                },
              }),
            };
          }
          return db.prepare(sql);
        },
        batch: (statements: unknown) =>
          (db as unknown as { batch: (s: unknown) => unknown }).batch(statements),
      } as unknown as D1Database;

      const revokeFails = new Error('google unavailable');
      let thrown: unknown;
      try {
        await disconnectGmailAccount(
          flakyDb,
          kek,
          fakeGoogleClient({
            revokeToken: async () => {
              throw revokeFails;
            },
          }),
          { sourceAccountId: accounts.gmailAccountId, now: FIXTURE_NOW, clock: () => FIXTURE_NOW },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(DisconnectRecoveryMarkerWriteFailedError);
      const typed = thrown as DisconnectRecoveryMarkerWriteFailedError;
      expect(typed.sourceAccountId).toBe(accounts.gmailAccountId);
      expect(typed.phase).toBe('revoke-ambiguous');
      expect(typed.originalExternalError).toBe(revokeFails);
      expect(typed.cause).toBe(markerWriteFails);

      // The lock is still held (correct -- the original ambiguity is genuinely unresolved) but is
      // UNDISCOVERABLE via the normal listing, since recovery_state was never actually persisted.
      const wedged = await listWedgedGmailDisconnectLocks(db);
      expect(wedged).toHaveLength(0);

      // ...and a fresh connect attempt is correctly refused, proving the lock really is still held
      // even though it is invisible to the "safe" listing above.
      const blocked = await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-2',
        codeVerifier: 'verifier-2',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });
      expect(blocked).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });
    },
  );

  it(
    'GPT-PM round-10 full-sweep MAJOR B: a stopWatch-ambiguous failure is recorded as ' +
      'STOP_WATCH_OUTCOME_UNKNOWN, distinct from a revokeToken-ambiguous REVOKE_OUTCOME_UNKNOWN -- ' +
      'reconciling it only releases the lock (local state untouched, since revokeToken was never ' +
      'invoked this attempt), and a caller supplying the WRONG phase is refused as STALE_LOCK rather ' +
      'than silently reconciling the wrong kind of ambiguity',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const stopFails = new Error('google unavailable (stopWatch)');
      await expect(
        disconnectGmailAccount(
          db,
          kek,
          fakeGoogleClient({
            stopWatch: async () => {
              throw stopFails;
            },
          }),
          { sourceAccountId: accounts.gmailAccountId, now: FIXTURE_NOW, clock: () => FIXTURE_NOW },
        ),
      ).rejects.toThrow(DisconnectAmbiguousExternalCallError);

      const wedged = await listWedgedGmailDisconnectLocks(db);
      expect(wedged).toHaveLength(1);
      expect(wedged[0]?.outcomeUnknown).toBe('STOP_WATCH_OUTCOME_UNKNOWN');

      // Supplying the WRONG phase (claiming this was a revoke ambiguity) is refused, not silently
      // "reconciled" as the wrong kind of outcome.
      const wrongPhase = await reconcileWedgedGmailDisconnectLock(db, {
        sourceAccountId: accounts.gmailAccountId,
        lockToken: wedged[0]!.lockToken,
        now: FIXTURE_NOW,
        outcome: { phase: 'REVOKE_OUTCOME_UNKNOWN', confirmed: 'REVOKE_NOT_APPLICABLE' },
      });
      expect(wrongPhase).toBe('STALE_LOCK');
      expect(await listWedgedGmailDisconnectLocks(db)).toHaveLength(1);

      // The CORRECT phase reconciles -- release only, connection row untouched (a stopWatch
      // ambiguity never reached revokeToken or any local cleanup this attempt).
      const reconcileResult = await reconcileWedgedGmailDisconnectLock(db, {
        sourceAccountId: accounts.gmailAccountId,
        lockToken: wedged[0]!.lockToken,
        now: FIXTURE_NOW,
        outcome: { phase: 'STOP_WATCH_OUTCOME_UNKNOWN', confirmed: 'STOP_NOT_APPLICABLE' },
      });
      expect(reconcileResult).toBe('RECONCILED');
      expect(await listWedgedGmailDisconnectLocks(db)).toHaveLength(0);

      const connectionRow = await db
        .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
        .bind(accounts.gmailAccountId)
        .first();
      expect(connectionRow).not.toBeNull();

      // A fresh disconnect attempt now succeeds normally (stopWatch on an already-stopped watch is
      // expected to be idempotent, per this module's own documented assumption).
      const freshDisconnect = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => FIXTURE_NOW,
      });
      expect(freshDisconnect).toEqual({ outcome: 'DISCONNECTED' });
    },
  );

  it(
    'GPT-PM round-10 full-sweep MAJOR B, result corrected round 12 (GPT-PM round-11 full-sweep ' +
      'MAJOR): REVOKE_NOT_APPLICABLE (Google confirms the revoke never reached it) only releases ' +
      'the lock (must NOT take the REVOKE_CONFIRMED atomic-finalize path, must NOT touch ' +
      'gmail_connections or revoke_settled_at) -- but stopWatch() already succeeded before this ' +
      'phase was ever reached, so the result is RECONCILED_RETRY_DISCONNECT_REQUIRED, not plain ' +
      'RECONCILED',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const revokeFails = new Error('google unavailable');
      await expect(
        disconnectGmailAccount(
          db,
          kek,
          fakeGoogleClient({
            revokeToken: async () => {
              throw revokeFails;
            },
          }),
          { sourceAccountId: accounts.gmailAccountId, now: FIXTURE_NOW, clock: () => FIXTURE_NOW },
        ),
      ).rejects.toThrow(DisconnectAmbiguousExternalCallError);

      const wedged = await listWedgedGmailDisconnectLocks(db);
      expect(wedged[0]?.outcomeUnknown).toBe('REVOKE_OUTCOME_UNKNOWN');

      const reconcileResult = await reconcileWedgedGmailDisconnectLock(db, {
        sourceAccountId: accounts.gmailAccountId,
        lockToken: wedged[0]!.lockToken,
        now: FIXTURE_NOW,
        outcome: { phase: 'REVOKE_OUTCOME_UNKNOWN', confirmed: 'REVOKE_NOT_APPLICABLE' },
      });
      expect(reconcileResult).toBe('RECONCILED_RETRY_DISCONNECT_REQUIRED');

      const connectionRow = await db
        .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
        .bind(accounts.gmailAccountId)
        .first();
      expect(connectionRow).not.toBeNull();

      // revoke_settled_at was NOT touched -- a fresh disconnect (this time succeeding normally)
      // proves the lock was genuinely free and local state was untouched by reconciliation.
      const freshDisconnect = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => FIXTURE_NOW,
      });
      expect(freshDisconnect).toEqual({ outcome: 'DISCONNECTED' });
    },
  );

  it(
    'GPT-PM round-10 full-sweep MAJOR B, result corrected round 12: STOP_CONFIRMED (Google confirms ' +
      'the watch WAS actually stopped) releases the lock but reports ' +
      'RECONCILED_RETRY_DISCONNECT_REQUIRED, not plain RECONCILED, since Gmail push has genuinely ' +
      'stopped while gmail_connections still says connected',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const stopFails = new Error('google unavailable (stopWatch)');
      await expect(
        disconnectGmailAccount(
          db,
          kek,
          fakeGoogleClient({
            stopWatch: async () => {
              throw stopFails;
            },
          }),
          { sourceAccountId: accounts.gmailAccountId, now: FIXTURE_NOW, clock: () => FIXTURE_NOW },
        ),
      ).rejects.toThrow(DisconnectAmbiguousExternalCallError);

      const wedged = await listWedgedGmailDisconnectLocks(db);
      expect(wedged[0]?.outcomeUnknown).toBe('STOP_WATCH_OUTCOME_UNKNOWN');

      const reconcileResult = await reconcileWedgedGmailDisconnectLock(db, {
        sourceAccountId: accounts.gmailAccountId,
        lockToken: wedged[0]!.lockToken,
        now: FIXTURE_NOW,
        outcome: { phase: 'STOP_WATCH_OUTCOME_UNKNOWN', confirmed: 'STOP_CONFIRMED' },
      });
      expect(reconcileResult).toBe('RECONCILED_RETRY_DISCONNECT_REQUIRED');

      // Local state untouched -- the caller is expected to retry disconnectGmailAccount, whose own
      // stopWatch retry is assumed idempotent.
      const connectionRow = await db
        .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
        .bind(accounts.gmailAccountId)
        .first();
      expect(connectionRow).not.toBeNull();

      const freshDisconnect = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
        clock: () => FIXTURE_NOW,
      });
      expect(freshDisconnect).toEqual({ outcome: 'DISCONNECTED' });
    },
  );

  it(
    'GPT-PM round-11 full-sweep MAJOR A (round-12 fix, acquisition write commits then throws, AND ' +
      'the recovery release itself also fails -- a double D1 failure): LifecycleLockRecoveryFailedError ' +
      'is thrown, carrying lockToken and BOTH errors, instead of silently rethrowing only the ' +
      'generic original acquisition error with no way to locate the lock',
    async () => {
      const { db, accounts, kek } = await setup();

      const acquireFails = new Error('transient D1 write error (acquisition)');
      const releaseFails = new Error('transient D1 write error (release, same incident)');
      const flakyDb: D1Database = {
        prepare: (sql: string) => {
          const normalized = sql.replace(/\s+/g, ' ');
          if (normalized.includes("lock_kind = 'CONNECT'")) {
            return {
              bind: (...args: unknown[]) => ({
                run: async () => {
                  await db
                    .prepare(sql)
                    .bind(...args)
                    .run();
                  throw acquireFails;
                },
              }),
            };
          }
          if (normalized.includes('source_account_id = NULL, recovery_state = NULL')) {
            return {
              bind: () => ({
                run: async () => {
                  throw releaseFails;
                },
              }),
            };
          }
          return db.prepare(sql);
        },
        batch: (statements: unknown) =>
          (db as unknown as { batch: (s: unknown) => unknown }).batch(statements),
      } as unknown as D1Database;

      let thrown: unknown;
      try {
        await connectGmailAccount(flakyDb, kek, fakeGoogleClient(), {
          sourceAccountId: accounts.gmailAccountId,
          code: 'auth-code',
          codeVerifier: 'verifier',
          collectionMode: 'PUSH',
          kekVersion: KEK_VERSION,
          now: FIXTURE_NOW,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(LifecycleLockRecoveryFailedError);
      const typed = thrown as LifecycleLockRecoveryFailedError;
      expect(typed.context).toBe('acquisition-write-release');
      expect(typed.originalError).toBe(acquireFails);
      expect(typed.cause).toBe(releaseFails);
      expect(typeof typed.lockToken).toBe('string');
      expect(typed.lockToken.length).toBeGreaterThan(0);
    },
  );

  it(
    'GPT-PM round-11 full-sweep MAJOR A (round-12 fix, local disconnect failure -- release also ' +
      "fails): the same LifecycleLockRecoveryFailedError contract applies to disconnectGmailAccount's " +
      'own catch-block release, not only the acquisition helper',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const selectFails = new Error('transient D1 read failure (credential SELECT)');
      const releaseFails = new Error('transient D1 write error (release)');
      const flakyDb: D1Database = {
        prepare: (sql: string) => {
          if (sql.includes('SELECT encrypted_refresh_token')) {
            return {
              bind: () => ({
                first: async () => {
                  throw selectFails;
                },
              }),
            };
          }
          const normalized = sql.replace(/\s+/g, ' ');
          if (normalized.includes('source_account_id = NULL, recovery_state = NULL')) {
            return {
              bind: () => ({
                run: async () => {
                  throw releaseFails;
                },
              }),
            };
          }
          return db.prepare(sql);
        },
        batch: (statements: unknown) =>
          (db as unknown as { batch: (s: unknown) => unknown }).batch(statements),
      } as unknown as D1Database;

      let thrown: unknown;
      try {
        await disconnectGmailAccount(flakyDb, kek, fakeGoogleClient(), {
          sourceAccountId: accounts.gmailAccountId,
          now: FIXTURE_NOW,
          clock: () => FIXTURE_NOW,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(LifecycleLockRecoveryFailedError);
      const typed = thrown as LifecycleLockRecoveryFailedError;
      expect(typed.context).toBe('disconnectGmailAccount-catch-release');
      expect(typed.originalError).toBe(selectFails);
      expect(typed.cause).toBe(releaseFails);
    },
  );

  it(
    'GPT-PM round-11 full-sweep MAJOR A (round-12 fix): the revoke-settled repair write, run after ' +
      'revokeToken() genuinely succeeded but the local batch failed, is ALSO protected -- its own ' +
      'failure throws LifecycleLockRecoveryFailedError rather than silently replacing the batch error',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const batchFails = new Error('local batch failure after revokeToken() resolved');
      const repairFails = new Error('transient D1 write error (revoke-settled repair)');
      const flakyDb: D1Database = {
        prepare: (sql: string) => {
          const normalized = sql.replace(/\s+/g, ' ');
          if (
            normalized.includes('revoke_settled_at = ?') &&
            normalized.includes("WHERE source = 'gmail' AND lock_token = ?")
          ) {
            return {
              bind: () => ({
                run: async () => {
                  throw repairFails;
                },
              }),
            };
          }
          return db.prepare(sql);
        },
        batch: async () => {
          throw batchFails;
        },
      } as unknown as D1Database;

      let thrown: unknown;
      try {
        await disconnectGmailAccount(flakyDb, kek, fakeGoogleClient(), {
          sourceAccountId: accounts.gmailAccountId,
          now: FIXTURE_NOW,
          clock: () => FIXTURE_NOW,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(LifecycleLockRecoveryFailedError);
      const typed = thrown as LifecycleLockRecoveryFailedError;
      expect(typed.context).toBe('disconnectGmailAccount-revoke-settled-repair');
      expect(typed.originalError).toBe(batchFails);
      expect(typed.cause).toBe(repairFails);
    },
  );

  it(
    'GPT-PM round-11 full-sweep MINOR (round-12 fix): a recovery_state marker write that actually ' +
      'COMMITS before its response is lost still throws DisconnectRecoveryMarkerWriteFailedError, but ' +
      'the lock IS then genuinely discoverable via listWedgedGmailDisconnectLocks -- the error must ' +
      'not claim it definitely is not',
    async () => {
      const { db, accounts, kek } = await setup();
      await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code',
        codeVerifier: 'verifier',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });

      const markerWriteFails = new Error('transient D1 write error (response lost after commit)');
      const flakyDb: D1Database = {
        prepare: (sql: string) => {
          if (sql.includes('SET recovery_state = ?')) {
            return {
              bind: (...args: unknown[]) => ({
                run: async () => {
                  // Simulate: the write genuinely landed at D1, but the response was lost locally.
                  await db
                    .prepare(sql)
                    .bind(...args)
                    .run();
                  throw markerWriteFails;
                },
              }),
            };
          }
          return db.prepare(sql);
        },
        batch: (statements: unknown) =>
          (db as unknown as { batch: (s: unknown) => unknown }).batch(statements),
      } as unknown as D1Database;

      const revokeFails = new Error('google unavailable');
      let thrown: unknown;
      try {
        await disconnectGmailAccount(
          flakyDb,
          kek,
          fakeGoogleClient({
            revokeToken: async () => {
              throw revokeFails;
            },
          }),
          { sourceAccountId: accounts.gmailAccountId, now: FIXTURE_NOW, clock: () => FIXTURE_NOW },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(DisconnectRecoveryMarkerWriteFailedError);

      // Unlike the round-11 marker test above (write never even attempted), the marker DID commit
      // here -- the lock is genuinely discoverable via the normal listing despite the thrown error,
      // proving the error's corrected wording ("whether it committed is UNKNOWN") rather than round
      // 11's wrong "UNDISCOVERABLE" claim.
      const wedged = await listWedgedGmailDisconnectLocks(db);
      expect(wedged).toHaveLength(1);
      expect(wedged[0]?.outcomeUnknown).toBe('REVOKE_OUTCOME_UNKNOWN');
    },
  );
});
