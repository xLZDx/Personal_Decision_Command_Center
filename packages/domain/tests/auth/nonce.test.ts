import { describe, expect, it } from 'vitest';
import { createTestD1, loadG2Schema } from '@pdos/testkit';

import { cleanupExpiredNonces, reserveNonce } from '../../src/auth/nonce.js';

describe('reserveNonce', () => {
  it('reserves a fresh nonce', async () => {
    const db = createTestD1(loadG2Schema());
    const ok = await reserveNonce(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      nonce: 'n-1',
      now: '2026-09-13T00:00:00.000Z',
    });
    expect(ok).toBe(true);
  });

  it('rejects a replayed (connector, key_version, nonce) triple', async () => {
    const db = createTestD1(loadG2Schema());
    await reserveNonce(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      nonce: 'n-1',
      now: '2026-09-13T00:00:00.000Z',
    });
    const replay = await reserveNonce(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      nonce: 'n-1',
      now: '2026-09-13T00:00:05.000Z',
    });
    expect(replay).toBe(false);
  });

  it('the same nonce is independent per connector', async () => {
    const db = createTestD1(loadG2Schema());
    await reserveNonce(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      nonce: 'n-1',
      now: '2026-09-13T00:00:00.000Z',
    });
    const otherConnector = await reserveNonce(db, {
      connectorId: 'telegram-connector',
      keyVersion: 'v1',
      nonce: 'n-1',
      now: '2026-09-13T00:00:00.000Z',
    });
    expect(otherConnector).toBe(true);
  });

  it('the same nonce is independent per key_version (rotation does not collide with the prior key)', async () => {
    const db = createTestD1(loadG2Schema());
    await reserveNonce(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      nonce: 'n-1',
      now: '2026-09-13T00:00:00.000Z',
    });
    const otherVersion = await reserveNonce(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v2',
      nonce: 'n-1',
      now: '2026-09-13T00:00:00.000Z',
    });
    expect(otherVersion).toBe(true);
  });

  it('exactly one of two concurrent reservations for the same triple succeeds', async () => {
    const db = createTestD1(loadG2Schema());
    const attempt = () =>
      reserveNonce(db, {
        connectorId: 'gmail-connector',
        keyVersion: 'v1',
        nonce: 'n-race',
        now: '2026-09-13T00:00:00.000Z',
      });
    const [a, b] = await Promise.all([attempt(), attempt()]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

describe('cleanupExpiredNonces', () => {
  it('deletes only nonces older than the accepted window, never a still-in-window one', async () => {
    const db = createTestD1(loadG2Schema());
    await reserveNonce(db, {
      connectorId: 'c1',
      keyVersion: 'v1',
      nonce: 'old',
      now: '2026-09-13T00:00:00.000Z',
    });
    await reserveNonce(db, {
      connectorId: 'c1',
      keyVersion: 'v1',
      nonce: 'fresh',
      now: '2026-09-13T00:09:00.000Z',
    });

    const deleted = await cleanupExpiredNonces(db, {
      now: '2026-09-13T00:10:00.000Z',
      windowMs: 5 * 60_000,
    });
    expect(deleted).toBe(1);

    const remaining = await db.prepare('SELECT nonce FROM ingest_nonces').all<{ nonce: string }>();
    expect(remaining.results.map((r) => r.nonce)).toEqual(['fresh']);
  });
});
