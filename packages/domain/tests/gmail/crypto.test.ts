/* global crypto, btoa, atob, TextEncoder, TextDecoder */
import { describe, expect, it } from 'vitest';

import { importKek, encryptRefreshToken, decryptRefreshToken } from '../../src/gmail/crypto.js';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A deterministic (non-random) 32-byte key, distinguishable from a hash digest of any short
 *  human-chosen passphrase by construction -- every byte is simply its own index. */
function deterministicKekSecret(): { bytes: Uint8Array; base64: string } {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = i;
  return { bytes, base64: bytesToBase64(bytes) };
}

const AAD_A = { gmailAccountId: 'acct-A', kekVersion: 'GMAIL_KEK_V1' };
const AAD_B = { gmailAccountId: 'acct-B', kekVersion: 'GMAIL_KEK_V1' };
const AAD_A_V2 = { gmailAccountId: 'acct-A', kekVersion: 'GMAIL_KEK_V2' };

describe('importKek', () => {
  it('KEK-entropy: a well-formed 32-byte base64 secret imports successfully', async () => {
    const { base64 } = deterministicKekSecret();
    await expect(importKek(base64)).resolves.toBeTruthy();
  });

  it('KEK-entropy: rejects a secret that does not decode to exactly 32 raw bytes', async () => {
    const shortSecret = bytesToBase64(new Uint8Array(16));
    await expect(importKek(shortSecret)).rejects.toThrow(/32 raw bytes/);
  });

  it(
    'security-review follow-up (MINOR): a not-actually-base64 secret surfaces a module-owned, ' +
      "recognizable error, not atob's own unlabeled native exception -- distinguishable from the " +
      'wrong-length case above',
    async () => {
      await expect(importKek('not-valid-base64!!!')).rejects.toThrow(/Invalid base64/);
    },
  );

  it(
    'KEK-entropy: the imported key IS the raw decoded bytes, not a hash of the secret string -- ' +
      'proven by importing the SAME 32 raw bytes independently via a bare crypto.subtle.importKey ' +
      'call, encrypting under that reference key, and confirming importKek() decrypts it correctly ' +
      '(a hashed-from-string derivation would produce different key material and fail to decrypt)',
    async () => {
      const { bytes, base64 } = deterministicKekSecret();
      const referenceKey = await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [
        'encrypt',
      ]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = new TextEncoder().encode('reference-aad');
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad },
        referenceKey,
        new TextEncoder().encode('plaintext-under-reference-key'),
      );

      const kek = await importKek(base64);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: aad },
        kek,
        ciphertext,
      );
      expect(new TextDecoder().decode(decrypted)).toBe('plaintext-under-reference-key');
    },
  );
});

describe('encryptRefreshToken / decryptRefreshToken', () => {
  it('round-trips a refresh token under a matching key and AAD', async () => {
    const { base64 } = deterministicKekSecret();
    const kek = await importKek(base64);
    const encrypted = await encryptRefreshToken(kek, '1//refresh-token-value', AAD_A);
    const decrypted = await decryptRefreshToken(kek, encrypted, AAD_A);
    expect(decrypted).toBe('1//refresh-token-value');
  });

  it(
    'functional-test review follow-up (MINOR): the IV is genuinely 12 bytes (96 bits, the ' +
      'documented/NIST-recommended AES-GCM size) -- pins the invariant so a regression in the ' +
      "module's own AES_GCM_IV_BYTES constant would be caught here rather than passing silently " +
      '(every other test stays green under any IV length WebCrypto accepts)',
    async () => {
      const { base64 } = deterministicKekSecret();
      const kek = await importKek(base64);
      const encrypted = await encryptRefreshToken(kek, 'some-token', AAD_A);
      const ivBytes = Uint8Array.from(atob(encrypted.iv), (c) => c.charCodeAt(0));
      expect(ivBytes.length).toBe(12);
    },
  );

  it('IV-uniqueness: two encryptions of the identical plaintext produce different IVs', async () => {
    const { base64 } = deterministicKekSecret();
    const kek = await importKek(base64);
    const first = await encryptRefreshToken(kek, 'same-plaintext', AAD_A);
    const second = await encryptRefreshToken(kek, 'same-plaintext', AAD_A);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it(
    "AAD-mismatch: ciphertext bound to account A is rejected when decrypted under account B's AAD " +
      '-- proves the AAD is genuinely load-bearing, not a decorative parameter',
    async () => {
      const { base64 } = deterministicKekSecret();
      const kek = await importKek(base64);
      const encrypted = await encryptRefreshToken(kek, 'secret-token', AAD_A);
      await expect(decryptRefreshToken(kek, encrypted, AAD_B)).rejects.toThrow();
    },
  );

  it('AAD-mismatch: a stale kek_version in the AAD (rotation not yet applied) also fails to decrypt', async () => {
    const { base64 } = deterministicKekSecret();
    const kek = await importKek(base64);
    const encrypted = await encryptRefreshToken(kek, 'secret-token', AAD_A);
    await expect(decryptRefreshToken(kek, encrypted, AAD_A_V2)).rejects.toThrow();
  });

  it(
    'functional-test review follow-up (MINOR): the length-prefixed AAD encoding is genuinely ' +
      'collision-resistant -- two AAD pairs that concatenate to the IDENTICAL string under a naive ' +
      "`gmailAccountId + kekVersion` join ('acct-A1'+''  vs 'acct-A'+'1', both 'acct-A1') are " +
      'still distinguished, because length-prefixing is what this encoding exists to guarantee ' +
      '(crypto.ts aadBytes() docstring)',
    async () => {
      const { base64 } = deterministicKekSecret();
      const kek = await importKek(base64);
      const naiveCollisionA = { gmailAccountId: 'acct-A1', kekVersion: '' };
      const naiveCollisionB = { gmailAccountId: 'acct-A', kekVersion: '1' };

      const encrypted = await encryptRefreshToken(kek, 'secret-token', naiveCollisionA);
      await expect(decryptRefreshToken(kek, encrypted, naiveCollisionB)).rejects.toThrow();
    },
  );

  it('a tampered ciphertext fails authentication rather than returning corrupted plaintext', async () => {
    const { base64 } = deterministicKekSecret();
    const kek = await importKek(base64);
    const encrypted = await encryptRefreshToken(kek, 'secret-token', AAD_A);
    const tamperedBytes = Uint8Array.from(atob(encrypted.ciphertext), (c) => c.charCodeAt(0));
    tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 0xff;
    const tampered = { ...encrypted, ciphertext: btoa(String.fromCharCode(...tamperedBytes)) };
    await expect(decryptRefreshToken(kek, tampered, AAD_A)).rejects.toThrow();
  });

  it(
    'rotation protocol (proposal §2.7): decrypt under the old key/version, re-encrypt under the ' +
      'new key/version -- the re-encrypted ciphertext decrypts correctly under V2 and no longer ' +
      'decrypts under V1',
    async () => {
      const v1 = deterministicKekSecret();
      const v2Bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) v2Bytes[i] = 31 - i;
      const v2Base64 = bytesToBase64(v2Bytes);

      const kekV1 = await importKek(v1.base64);
      const kekV2 = await importKek(v2Base64);

      const encryptedUnderV1 = await encryptRefreshToken(kekV1, 'rotate-me', AAD_A);
      const plaintext = await decryptRefreshToken(kekV1, encryptedUnderV1, AAD_A);
      const encryptedUnderV2 = await encryptRefreshToken(kekV2, plaintext, AAD_A_V2);

      expect(await decryptRefreshToken(kekV2, encryptedUnderV2, AAD_A_V2)).toBe('rotate-me');
      await expect(decryptRefreshToken(kekV1, encryptedUnderV2, AAD_A_V2)).rejects.toThrow();
    },
  );
});
