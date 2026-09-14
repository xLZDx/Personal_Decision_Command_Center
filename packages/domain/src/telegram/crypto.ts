/* global crypto, TextEncoder, TextDecoder, btoa, atob */
import type { webcrypto } from 'node:crypto';

type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;

const encoder = new TextEncoder();
const IV_BYTES = 12;
const NONCE_BYTES = 16;
const MAX_EXPIRY_MS = 60_000;
export const MAX_TELEGRAM_CIPHERTEXT_BYTES = 64 * 1024;
export const MAX_TELEGRAM_PLAINTEXT_BYTES = 64 * 1024;
export const MAX_TELEGRAM_KEY_ID_CHARS = 128;
export const MAX_TELEGRAM_REQUEST_ID_CHARS = 256;
export const MAX_TELEGRAM_SOURCE_REF_CHARS = 512;

export interface TelegramEcdhPublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface TelegramContentAad {
  keyId: string;
  requestId: string;
  sourceRef: string;
  schemaVersion: number;
  expiresAt: string;
  nonce: string;
}

export interface TelegramContentEnvelope {
  keyId: string;
  requestId: string;
  sourceRef: string;
  schemaVersion: number;
  expiresAt: string;
  nonce: string;
  iv: string;
  ciphertext: string;
}

export interface EncryptTelegramContentOptions {
  gatewayPrivateKey: CryptoKey;
  clientPublicJwk: TelegramEcdhPublicJwk;
  keyId: string;
  requestId: string;
  sourceRef: string;
  schemaVersion: number;
  expiresAt: string;
  plaintext: string;
  now?: string;
}

export interface DecryptTelegramContentOptions {
  clientPrivateKey: CryptoKey;
  gatewayPublicJwk: TelegramEcdhPublicJwk;
  expectedKeyId: string;
  envelope: TelegramContentEnvelope;
  now?: string;
  replayGuard: TelegramContentReplayGuard;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error('Invalid Telegram content base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function assertBoundedText(value: string, name: string, max: number): void {
  if (value.length === 0 || value.length > max) throw new Error(`Telegram ${name} exceeds limit`);
}

function aadBytes(aad: TelegramContentAad): Uint8Array {
  return encoder.encode(
    [aad.keyId, aad.requestId, aad.sourceRef, String(aad.schemaVersion), aad.expiresAt, aad.nonce]
      .map((part) => `${part.length}:${part}`)
      .join(''),
  );
}

function validateExpiry(expiresAt: string, now: string): void {
  const expires = Date.parse(expiresAt);
  const current = Date.parse(now);
  if (!Number.isFinite(expires) || !Number.isFinite(current) || expires <= current) {
    throw new Error('Telegram content request expired');
  }
  if (expires - current > MAX_EXPIRY_MS) {
    throw new Error('Telegram content request expiry exceeds 60 seconds');
  }
}

async function deriveAesKey(
  privateKey: CryptoKey,
  peerPublicJwk: TelegramEcdhPublicJwk,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const peerPublicKey = await crypto.subtle.importKey(
    'jwk',
    peerPublicJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode('pdos.telegram.content.v1') },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function generateTelegramEcdhKeyPair(): Promise<CryptoKeyPair> {
  const generated = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey('jwk', generated.privateKey);
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  return { publicKey: generated.publicKey, privateKey };
}

export async function exportTelegramEcdhPublicJwk(
  publicKey: CryptoKey,
): Promise<TelegramEcdhPublicJwk> {
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new Error('Telegram ECDH public key is not P-256');
  }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

export async function encryptTelegramContent(
  options: EncryptTelegramContentOptions,
): Promise<TelegramContentEnvelope> {
  const now = options.now ?? new Date().toISOString();
  assertBoundedText(options.keyId, 'keyId', MAX_TELEGRAM_KEY_ID_CHARS);
  assertBoundedText(options.requestId, 'requestId', MAX_TELEGRAM_REQUEST_ID_CHARS);
  assertBoundedText(options.sourceRef, 'sourceRef', MAX_TELEGRAM_SOURCE_REF_CHARS);
  if (new TextEncoder().encode(options.plaintext).length > MAX_TELEGRAM_PLAINTEXT_BYTES) {
    throw new Error('Telegram plaintext exceeds limit');
  }
  if (options.keyId.length === 0) throw new Error('Telegram content keyId is required');
  validateExpiry(options.expiresAt, now);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const nonceBase64 = bytesToBase64(nonce);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const aad = {
    requestId: options.requestId,
    keyId: options.keyId,
    sourceRef: options.sourceRef,
    schemaVersion: options.schemaVersion,
    expiresAt: options.expiresAt,
    nonce: nonceBase64,
  };
  const key = await deriveAesKey(options.gatewayPrivateKey, options.clientPublicJwk, nonce);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadBytes(aad) },
    key,
    encoder.encode(options.plaintext),
  );
  return {
    keyId: options.keyId,
    requestId: options.requestId,
    sourceRef: options.sourceRef,
    schemaVersion: options.schemaVersion,
    expiresAt: options.expiresAt,
    nonce: nonceBase64,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export class TelegramContentReplayGuard {
  readonly #seen = new Map<string, number>();

  accept(nonce: string, expiresAt: string, now: string): boolean {
    const current = Date.parse(now);
    for (const [seenNonce, expiry] of this.#seen) {
      if (expiry <= current) this.#seen.delete(seenNonce);
    }
    if (this.#seen.has(nonce)) return false;
    this.#seen.set(nonce, Date.parse(expiresAt));
    return true;
  }
}

export async function decryptTelegramContent(
  options: DecryptTelegramContentOptions,
): Promise<string> {
  const now = options.now ?? new Date().toISOString();
  assertBoundedText(options.envelope.keyId, 'keyId', MAX_TELEGRAM_KEY_ID_CHARS);
  assertBoundedText(options.envelope.requestId, 'requestId', MAX_TELEGRAM_REQUEST_ID_CHARS);
  assertBoundedText(options.envelope.sourceRef, 'sourceRef', MAX_TELEGRAM_SOURCE_REF_CHARS);
  validateExpiry(options.envelope.expiresAt, now);
  if (options.envelope.keyId !== options.expectedKeyId) {
    throw new Error('Telegram content keyId mismatch');
  }
  const nonce = base64ToBytes(options.envelope.nonce);
  if (nonce.length !== NONCE_BYTES) throw new Error('Invalid Telegram content nonce');
  const iv = base64ToBytes(options.envelope.iv);
  if (iv.length !== IV_BYTES) throw new Error('Invalid Telegram content IV');
  const ciphertext = base64ToBytes(options.envelope.ciphertext);
  if (ciphertext.length > MAX_TELEGRAM_CIPHERTEXT_BYTES) {
    throw new Error('Telegram ciphertext exceeds limit');
  }
  const aad: TelegramContentAad = {
    keyId: options.envelope.keyId,
    requestId: options.envelope.requestId,
    sourceRef: options.envelope.sourceRef,
    schemaVersion: options.envelope.schemaVersion,
    expiresAt: options.envelope.expiresAt,
    nonce: options.envelope.nonce,
  };
  const key = await deriveAesKey(options.clientPrivateKey, options.gatewayPublicJwk, nonce);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: aadBytes(aad),
    },
    key,
    ciphertext,
  );
  if (plaintext.byteLength > MAX_TELEGRAM_PLAINTEXT_BYTES) {
    throw new Error('Telegram plaintext exceeds limit');
  }
  if (!options.replayGuard.accept(options.envelope.nonce, options.envelope.expiresAt, now)) {
    throw new Error('Telegram content request replayed');
  }
  return new TextDecoder().decode(plaintext);
}
