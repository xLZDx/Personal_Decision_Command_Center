import { describe, expect, it } from 'vitest';

import {
  canonicalSigningPayload,
  isTimestampWithinWindow,
  sha256Hex,
  signHmac,
  verifyHmacSignature,
} from '../../src/auth/hmac.js';

describe('verifyHmacSignature / signHmac', () => {
  it('a signature produced by signHmac verifies against the same secret and payload', async () => {
    const signature = await signHmac('secret-1', 'payload-1');
    expect(await verifyHmacSignature('secret-1', 'payload-1', signature)).toBe(true);
  });

  it('rejects a signature produced with a different secret', async () => {
    const signature = await signHmac('secret-1', 'payload-1');
    expect(await verifyHmacSignature('secret-2', 'payload-1', signature)).toBe(false);
  });

  it('rejects a signature for a different payload (tamper detection)', async () => {
    const signature = await signHmac('secret-1', 'payload-1');
    expect(await verifyHmacSignature('secret-1', 'payload-1-tampered', signature)).toBe(false);
  });

  it('rejects malformed hex without throwing', async () => {
    expect(await verifyHmacSignature('secret-1', 'payload-1', 'not-hex!!')).toBe(false);
    expect(await verifyHmacSignature('secret-1', 'payload-1', 'abc')).toBe(false); // odd length
  });
});

describe('canonicalSigningPayload', () => {
  it('produces distinct strings for fields that would collide under naive concatenation', () => {
    const a = canonicalSigningPayload({
      method: 'POST',
      path: '/ingest',
      timestamp: 'ab',
      nonce: 'cdef',
      bodyHash: 'h',
    });
    const b = canonicalSigningPayload({
      method: 'POST',
      path: '/ingest',
      timestamp: 'abcd',
      nonce: 'ef',
      bodyHash: 'h',
    });
    expect(a).not.toBe(b);
  });
});

describe('sha256Hex', () => {
  it('is deterministic and produces 64 hex characters', async () => {
    const a = await sha256Hex('hello');
    const b = await sha256Hex('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isTimestampWithinWindow', () => {
  it('accepts a timestamp exactly at the window boundary', () => {
    expect(
      isTimestampWithinWindow('2026-09-13T00:00:00.000Z', '2026-09-13T00:05:00.000Z', 300_000),
    ).toBe(true);
  });
  it('rejects a timestamp just past the window boundary', () => {
    expect(
      isTimestampWithinWindow('2026-09-13T00:00:00.000Z', '2026-09-13T00:05:00.001Z', 300_000),
    ).toBe(false);
  });
  it('accepts a timestamp slightly in the future (clock skew)', () => {
    expect(
      isTimestampWithinWindow('2026-09-13T00:05:00.000Z', '2026-09-13T00:00:00.000Z', 300_000),
    ).toBe(true);
  });
  it('rejects an unparseable timestamp', () => {
    expect(isTimestampWithinWindow('not-a-date', '2026-09-13T00:00:00.000Z', 300_000)).toBe(false);
  });
});
