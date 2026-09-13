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
    'functional-test review follow-up (MAJOR): revokeToken throwing propagates rather than being ' +
      'silently swallowed -- the connection row and oauth_flows are left completely untouched, ' +
      'proving a failed Google-side revoke can never be masked by "successful" local cleanup',
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

      await expect(
        disconnectGmailAccount(db, kek, failingClient, {
          sourceAccountId: accounts.gmailAccountId,
          now: FIXTURE_NOW,
        }),
      ).rejects.toThrow(revokeFails);

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
    },
  );

  it(
    'security review follow-up: a transient failure (revokeToken throws) leaves the row intact, ' +
      'so a RETRY with a working client still completes disconnect correctly -- proves the ordering ' +
      'is retry-safe, not just fail-closed once',
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

      const failingClient = fakeGoogleClient({
        revokeToken: async () => {
          throw new Error('transient google failure');
        },
      });
      await expect(
        disconnectGmailAccount(db, kek, failingClient, {
          sourceAccountId: accounts.gmailAccountId,
          now: FIXTURE_NOW,
        }),
      ).rejects.toThrow();

      const retryResult = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
      });
      expect(retryResult).toEqual({ outcome: 'DISCONNECTED' });

      const row = await db
        .prepare('SELECT 1 FROM gmail_connections WHERE source_account_id = ?')
        .bind(accounts.gmailAccountId)
        .first();
      expect(row).toBeNull();
    },
  );

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
          });
        },
      });

      const firstResult = await disconnectGmailAccount(db, kek, client, {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
      });

      expect(secondResult).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });
      expect(firstResult).toEqual({ outcome: 'DISCONNECTED' });
    },
  );

  it(
    'GPT-PM round 5/6 MAJOR (superseding rounds 4/5): a reconnect is refused even when the ' +
      "lease's OWN stored expiry has already passed, as long as disconnect is still genuinely " +
      'running -- proving reconnect eligibility depends on the lease being CLEARED (an actual ' +
      'settlement), never on elapsed client-side time, which is exactly the property rounds 4 and ' +
      '5 each got wrong in a different way',
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
          // While disconnect is still genuinely mid-flight (inside its own revokeToken call),
          // force the row's OWN stored expiry into the past -- exactly what a round 4/5-style
          // design would have read as "safe to let reconnect through." A correct design must
          // still refuse here, since this disconnect attempt has not settled.
          await db
            .prepare(
              'UPDATE gmail_connections SET disconnect_lease_expires_at = ? WHERE source_account_id = ?',
            )
            .bind(
              new Date(Date.parse(FIXTURE_NOW) - 1_000_000).toISOString(),
              accounts.gmailAccountId,
            )
            .run();

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
      });

      expect(reconnectResult).toEqual({ outcome: 'DISCONNECT_IN_PROGRESS' });
      expect(result).toEqual({ outcome: 'DISCONNECTED' });
    },
  );

  it(
    'recovery is via retrying disconnectGmailAccount, never via connectGmailAccount timing out a ' +
      'stale lease: an abandoned lease (the shape a disconnect that crashed outright, never ' +
      'reaching its own catch block, would leave behind) keeps refusing reconnect indefinitely -- ' +
      'only a fresh disconnectGmailAccount call for the same account can take it over ' +
      '(DISCONNECT_LEASE_DURATION_MS still governs THAT contention) and actually clear it by ' +
      'completing',
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

      // Simulate an abandoned lease directly at the schema level, with a stored expiry far in the
      // past -- the exact shape a crashed disconnectGmailAccount call would leave behind.
      await db
        .prepare(
          'UPDATE gmail_connections SET disconnect_lease_token = ?, disconnect_lease_expires_at = ? WHERE source_account_id = ?',
        )
        .bind(
          'abandoned-lease',
          new Date(Date.parse(FIXTURE_NOW) - 1_000_000).toISOString(),
          accounts.gmailAccountId,
        )
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

      const recovered = await disconnectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        now: FIXTURE_NOW,
      });
      expect(recovered).toEqual({ outcome: 'DISCONNECTED' });

      const afterRecovery = await connectGmailAccount(db, kek, fakeGoogleClient(), {
        sourceAccountId: accounts.gmailAccountId,
        code: 'auth-code-3',
        codeVerifier: 'verifier-3',
        collectionMode: 'PUSH',
        kekVersion: KEK_VERSION,
        now: FIXTURE_NOW,
      });
      expect(afterRecovery).toEqual({ outcome: 'CONNECTED' });
    },
  );

  it(
    'GPT-PM round-1 MAJOR #2: the connection delete and the oauth_flows clear are ONE atomic ' +
      'db.batch() -- when the batch itself fails, NEITHER takes effect, so a retry is never stuck ' +
      'seeing a half-cleaned-up state',
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
    },
  );
});
