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
});
