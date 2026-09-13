import { describe, expect, it } from 'vitest';
import { createTestD1, loadG2Schema, seedSigningKey, TEST_HMAC_SECRET } from '@pdos/testkit';

import { authenticateIngestRequest } from '../../src/auth/authenticate.js';
import { canonicalSigningPayload, signHmac } from '../../src/auth/hmac.js';

const NOW = '2026-09-13T00:00:00.000Z';

async function setup() {
  const db = createTestD1(loadG2Schema());
  await seedSigningKey(db, {
    connectorId: 'gmail-connector',
    keyVersion: 'v1',
    status: 'ACTIVE',
    validFrom: '2026-09-01T00:00:00.000Z',
    validUntil: null,
  });
  return db;
}

async function buildRequest(
  overrides: Partial<{ timestamp: string; nonce: string; secret: string }> = {},
) {
  const timestamp = overrides.timestamp ?? NOW;
  const nonce = overrides.nonce ?? 'nonce-1';
  const payload = canonicalSigningPayload({
    method: 'POST',
    path: '/ingest/gmail',
    timestamp,
    nonce,
    bodyHash: 'deadbeef',
  });
  const signatureHex = await signHmac(overrides.secret ?? TEST_HMAC_SECRET, payload);
  return { timestamp, nonce, payload, signatureHex };
}

describe('authenticateIngestRequest', () => {
  it('accepts a well-formed, correctly signed, fresh request', async () => {
    const db = await setup();
    const req = await buildRequest();
    const result = await authenticateIngestRequest(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      secret: TEST_HMAC_SECRET,
      timestamp: req.timestamp,
      nonce: req.nonce,
      signatureHex: req.signatureHex,
      payload: req.payload,
      now: NOW,
      timestampWindowMs: 5 * 60_000,
    });
    expect(result).toEqual({ ok: true });
  });

  it('rejects an unknown key version before ever checking the signature', async () => {
    const db = await setup();
    const req = await buildRequest();
    const result = await authenticateIngestRequest(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v-does-not-exist',
      secret: TEST_HMAC_SECRET,
      timestamp: req.timestamp,
      nonce: req.nonce,
      signatureHex: req.signatureHex,
      payload: req.payload,
      now: NOW,
      timestampWindowMs: 5 * 60_000,
    });
    expect(result).toEqual({ ok: false, reason: 'UNKNOWN_KEY' });
  });

  it('rejects a revoked key', async () => {
    const db = createTestD1(loadG2Schema());
    await seedSigningKey(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      status: 'REVOKED',
    });
    const req = await buildRequest();
    const result = await authenticateIngestRequest(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      secret: TEST_HMAC_SECRET,
      timestamp: req.timestamp,
      nonce: req.nonce,
      signatureHex: req.signatureHex,
      payload: req.payload,
      now: NOW,
      timestampWindowMs: 5 * 60_000,
    });
    expect(result).toEqual({ ok: false, reason: 'REVOKED_KEY' });
  });

  it('rejects a timestamp outside the accepted window', async () => {
    const db = await setup();
    const req = await buildRequest({ timestamp: '2026-09-13T00:20:00.000Z' });
    const result = await authenticateIngestRequest(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      secret: TEST_HMAC_SECRET,
      timestamp: req.timestamp,
      nonce: req.nonce,
      signatureHex: req.signatureHex,
      payload: req.payload,
      now: NOW,
      timestampWindowMs: 5 * 60_000,
    });
    expect(result).toEqual({ ok: false, reason: 'TIMESTAMP_OUT_OF_WINDOW' });
  });

  it('rejects a bad signature (wrong secret)', async () => {
    const db = await setup();
    const req = await buildRequest({ secret: 'wrong-secret' });
    const result = await authenticateIngestRequest(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      secret: TEST_HMAC_SECRET,
      timestamp: req.timestamp,
      nonce: req.nonce,
      signatureHex: req.signatureHex,
      payload: req.payload,
      now: NOW,
      timestampWindowMs: 5 * 60_000,
    });
    expect(result).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('rejects a replayed nonce on a second, identically-valid request', async () => {
    const db = await setup();
    const req = await buildRequest();
    const args = {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      secret: TEST_HMAC_SECRET,
      timestamp: req.timestamp,
      nonce: req.nonce,
      signatureHex: req.signatureHex,
      payload: req.payload,
      now: NOW,
      timestampWindowMs: 5 * 60_000,
    };
    const first = await authenticateIngestRequest(db, args);
    expect(first).toEqual({ ok: true });
    const replay = await authenticateIngestRequest(db, args);
    expect(replay).toEqual({ ok: false, reason: 'REPLAYED_NONCE' });
  });

  it("does NOT consume the nonce when the signature is invalid (a forged replay cannot burn a real sender's nonce)", async () => {
    const db = await setup();
    const req = await buildRequest({ secret: 'wrong-secret' });
    await authenticateIngestRequest(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      secret: TEST_HMAC_SECRET,
      timestamp: req.timestamp,
      nonce: req.nonce,
      signatureHex: req.signatureHex,
      payload: req.payload,
      now: NOW,
      timestampWindowMs: 5 * 60_000,
    });

    // The SAME nonce, now with a genuine signature, must still succeed.
    const genuinePayload = canonicalSigningPayload({
      method: 'POST',
      path: '/ingest/gmail',
      timestamp: req.timestamp,
      nonce: req.nonce,
      bodyHash: 'deadbeef',
    });
    const genuineSignature = await signHmac(TEST_HMAC_SECRET, genuinePayload);
    const result = await authenticateIngestRequest(db, {
      connectorId: 'gmail-connector',
      keyVersion: 'v1',
      secret: TEST_HMAC_SECRET,
      timestamp: req.timestamp,
      nonce: req.nonce,
      signatureHex: genuineSignature,
      payload: genuinePayload,
      now: NOW,
      timestampWindowMs: 5 * 60_000,
    });
    expect(result).toEqual({ ok: true });
  });
});
