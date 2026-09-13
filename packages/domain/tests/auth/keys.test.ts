import { describe, expect, it } from 'vitest';
import { createTestD1, loadG2Schema, seedSigningKey } from '@pdos/testkit';

import { lookupSigningKeyStatus } from '../../src/auth/keys.js';

describe('lookupSigningKeyStatus', () => {
  it('UNKNOWN for a (connector, key_version) pair with no row', async () => {
    const db = createTestD1(loadG2Schema());
    const status = await lookupSigningKeyStatus(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      now: '2026-09-13T00:00:00.000Z',
    });
    expect(status).toBe('UNKNOWN');
  });

  it('VALID for an ACTIVE key within its validity window', async () => {
    const db = createTestD1(loadG2Schema());
    await seedSigningKey(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      status: 'ACTIVE',
      validFrom: '2026-09-01T00:00:00.000Z',
      validUntil: null,
    });
    const status = await lookupSigningKeyStatus(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      now: '2026-09-13T00:00:00.000Z',
    });
    expect(status).toBe('VALID');
  });

  it('REVOKED for a key marked REVOKED, regardless of its validity window', async () => {
    const db = createTestD1(loadG2Schema());
    await seedSigningKey(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      status: 'REVOKED',
      validFrom: '2026-09-01T00:00:00.000Z',
      validUntil: null,
    });
    const status = await lookupSigningKeyStatus(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      now: '2026-09-13T00:00:00.000Z',
    });
    expect(status).toBe('REVOKED');
  });

  it('NOT_YET_VALID before valid_from', async () => {
    const db = createTestD1(loadG2Schema());
    await seedSigningKey(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      validFrom: '2026-09-20T00:00:00.000Z',
    });
    const status = await lookupSigningKeyStatus(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      now: '2026-09-13T00:00:00.000Z',
    });
    expect(status).toBe('NOT_YET_VALID');
  });

  it('EXPIRED after valid_until', async () => {
    const db = createTestD1(loadG2Schema());
    await seedSigningKey(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      validFrom: '2026-08-01T00:00:00.000Z',
      validUntil: '2026-09-01T00:00:00.000Z',
    });
    const status = await lookupSigningKeyStatus(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      now: '2026-09-13T00:00:00.000Z',
    });
    expect(status).toBe('EXPIRED');
  });

  it('security fix (G2 gate review MAJOR): UNKNOWN, not VALID, for a malformed valid_from -- fails closed rather than open', async () => {
    const db = createTestD1(loadG2Schema());
    // Bypasses the typed seedSigningKey fixture on purpose: this simulates corrupted/malformed
    // provisioning data landing directly in D1, which is exactly the scenario the fix guards.
    await db
      .prepare(
        'INSERT INTO ingest_signing_keys (connector_id, key_version, status, valid_from, valid_until) VALUES (?,?,?,?,?)',
      )
      .bind('gmail-connector', 'v1', 'ACTIVE', 'not-a-real-date', null)
      .run();
    const status = await lookupSigningKeyStatus(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      now: '2026-09-13T00:00:00.000Z',
    });
    expect(status).toBe('UNKNOWN');
  });

  it('security fix (G2 gate review MAJOR): UNKNOWN, not VALID, for a malformed valid_until -- fails closed rather than open', async () => {
    const db = createTestD1(loadG2Schema());
    await db
      .prepare(
        'INSERT INTO ingest_signing_keys (connector_id, key_version, status, valid_from, valid_until) VALUES (?,?,?,?,?)',
      )
      .bind('gmail-connector', 'v1', 'ACTIVE', '2026-08-01T00:00:00.000Z', 'garbage')
      .run();
    const status = await lookupSigningKeyStatus(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      now: '2026-09-13T00:00:00.000Z',
    });
    expect(status).toBe('UNKNOWN');
  });
});
