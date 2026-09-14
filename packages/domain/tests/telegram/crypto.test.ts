/* global crypto */
import { describe, expect, it } from 'vitest';

import {
  decryptTelegramContent,
  encryptTelegramContent,
  exportTelegramEcdhPublicJwk,
  generateTelegramEcdhKeyPair,
  TelegramContentReplayGuard,
} from '../../src/telegram/crypto.js';

const NOW = '2026-09-14T10:00:00.000Z';
const EXPIRES = '2026-09-14T10:00:30.000Z';

describe('Telegram content ECDH/HKDF/AES-GCM envelope', () => {
  it('round-trips plaintext with a fresh nonce and binds request metadata as AAD', async () => {
    const gateway = await generateTelegramEcdhKeyPair();
    const client = await generateTelegramEcdhKeyPair();
    await expect(crypto.subtle.exportKey('jwk', gateway.privateKey)).rejects.toThrow();
    const gatewayPublicJwk = await exportTelegramEcdhPublicJwk(gateway.publicKey);
    const clientPublicJwk = await exportTelegramEcdhPublicJwk(client.publicKey);
    const envelope = await encryptTelegramContent({
      gatewayPrivateKey: gateway.privateKey,
      clientPublicJwk,
      keyId: 'gateway-k1',
      requestId: 'request-1',
      sourceRef: 'telegram-message-1',
      schemaVersion: 1,
      expiresAt: EXPIRES,
      plaintext: 'original Telegram content',
      now: NOW,
    });
    const guard = new TelegramContentReplayGuard();
    await expect(
      decryptTelegramContent({
        clientPrivateKey: client.privateKey,
        gatewayPublicJwk,
        expectedKeyId: 'gateway-k1',
        envelope,
        now: NOW,
        replayGuard: guard,
      }),
    ).resolves.toBe('original Telegram content');
    await expect(
      decryptTelegramContent({
        clientPrivateKey: client.privateKey,
        gatewayPublicJwk,
        expectedKeyId: 'gateway-k1',
        envelope: { ...envelope, sourceRef: 'telegram-message-2' },
        now: NOW,
        replayGuard: new TelegramContentReplayGuard(),
      }),
    ).rejects.toThrow();
  });

  it('rejects replay, expiry beyond 60 seconds, and expired envelopes', async () => {
    const gateway = await generateTelegramEcdhKeyPair();
    const client = await generateTelegramEcdhKeyPair();
    const gatewayPublicJwk = await exportTelegramEcdhPublicJwk(gateway.publicKey);
    const clientPublicJwk = await exportTelegramEcdhPublicJwk(client.publicKey);
    const envelope = await encryptTelegramContent({
      gatewayPrivateKey: gateway.privateKey,
      clientPublicJwk,
      keyId: 'gateway-k1',
      requestId: 'request-2',
      sourceRef: 'telegram-message-2',
      schemaVersion: 1,
      expiresAt: EXPIRES,
      plaintext: 'one-time content',
      now: NOW,
    });
    const guard = new TelegramContentReplayGuard();
    await decryptTelegramContent({
      clientPrivateKey: client.privateKey,
      gatewayPublicJwk,
      expectedKeyId: 'gateway-k1',
      envelope,
      now: NOW,
      replayGuard: guard,
    });
    await expect(
      decryptTelegramContent({
        clientPrivateKey: client.privateKey,
        gatewayPublicJwk,
        expectedKeyId: 'gateway-k1',
        envelope,
        now: NOW,
        replayGuard: guard,
      }),
    ).rejects.toThrow(/replayed/);
    await expect(
      decryptTelegramContent({
        clientPrivateKey: client.privateKey,
        gatewayPublicJwk,
        expectedKeyId: 'gateway-k1',
        envelope,
        now: '2026-09-14T10:00:31.000Z',
        replayGuard: new TelegramContentReplayGuard(),
      }),
    ).rejects.toThrow(/expired/);
    await expect(
      encryptTelegramContent({
        gatewayPrivateKey: gateway.privateKey,
        clientPublicJwk,
        keyId: 'gateway-k1',
        requestId: 'request-3',
        sourceRef: 'telegram-message-3',
        schemaVersion: 1,
        expiresAt: '2026-09-14T10:02:00.000Z',
        plaintext: 'too long',
        now: NOW,
      }),
    ).rejects.toThrow(/60 seconds/);
    await expect(
      decryptTelegramContent({
        clientPrivateKey: client.privateKey,
        gatewayPublicJwk,
        expectedKeyId: 'gateway-k2',
        envelope,
        now: NOW,
        replayGuard: new TelegramContentReplayGuard(),
      }),
    ).rejects.toThrow(/keyId mismatch/);
    await expect(
      decryptTelegramContent({
        clientPrivateKey: client.privateKey,
        gatewayPublicJwk,
        expectedKeyId: 'gateway-k2',
        envelope: { ...envelope, keyId: 'gateway-k2' },
        now: NOW,
        replayGuard: new TelegramContentReplayGuard(),
      }),
    ).rejects.toThrow(/operation|decrypt|auth/i);
    await expect(
      decryptTelegramContent({
        clientPrivateKey: client.privateKey,
        gatewayPublicJwk,
        expectedKeyId: 'gateway-k1',
        envelope: { ...envelope, ciphertext: 'A'.repeat(100_000) },
        now: NOW,
        replayGuard: new TelegramContentReplayGuard(),
      }),
    ).rejects.toThrow(/ciphertext|base64/);
  });
});
