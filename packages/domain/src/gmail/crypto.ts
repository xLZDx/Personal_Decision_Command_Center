/* global crypto, TextEncoder, TextDecoder, btoa, atob */
// Web Platform APIs ambient under both Node (tests) and the Cloudflare Workers runtime
// (production) -- no import needed either way, same convention as packages/domain/src/auth/hmac.ts.
// `CryptoKey` itself has no DOM lib in this tsconfig (lib: ["ES2022"], types: ["node"]), so the
// ambient global `crypto` type-checks as Node's `webcrypto.Crypto` -- import ONLY the matching type
// from `node:crypto` (erased at compile time, no runtime Node dependency in the Workers bundle).
import type { webcrypto } from 'node:crypto';
type CryptoKey = webcrypto.CryptoKey;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const AES_GCM_IV_BYTES = 12; // 96-bit IV, the standard/recommended size for AES-GCM
const KEK_RAW_BYTES = 32; // AES-256

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Wraps `atob`'s own generic exception (security review, checkpoint 3 MINOR) so a malformed
 * `GMAIL_KEK_V{n}` secret, a corrupted D1 `encrypted_refresh_token`/`refresh_token_iv` value, or any
 * other not-actually-base64 input surfaces a module-owned, recognizable error -- distinguishable
 * from `importKek`'s own "wrong length" error by callers that want to tell the two failure modes
 * apart -- rather than an unlabeled native `DOMException`.
 */
function base64ToBytes(base64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(base64);
  } catch (error) {
    throw new Error(
      `Invalid base64 input: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Imports a KEK (proposal §2.7): a dedicated, randomly-generated 256-bit key provisioned directly
 * as a Worker Secret (`GMAIL_KEK_V{n}`), base64-encoded -- decoded here as RAW key bytes, never
 * hashed from a passphrase (GPT-PM's correction of the V1 design, which derived the KEK via
 * `sha256(WORKER_SECRET)` -- length-guaranteed but not entropy-guaranteed, since a human-chosen
 * passphrase's real entropy is far below 256 bits regardless of its hash's output length). Rejects
 * anything that does not decode to exactly 32 raw bytes rather than silently truncating/padding, so
 * a misconfigured secret fails at import time, not at first encrypt/decrypt.
 */
export async function importKek(base64Secret: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64Secret);
  if (raw.length !== KEK_RAW_BYTES) {
    throw new Error(
      `GMAIL_KEK must decode to exactly ${KEK_RAW_BYTES} raw bytes, got ${raw.length}`,
    );
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export interface EncryptedRefreshToken {
  ciphertext: string; // base64
  iv: string; // base64
}

/**
 * The AAD identity a ciphertext is bound to (proposal §2.7): `gmail_account_id || kek_version`.
 * Decrypting under a different account or key-ring version's AAD fails AES-GCM's own authentication
 * check rather than silently succeeding -- closes the "ciphertext silently transplanted between
 * account rows" gap even though today's single-account MVP1 scale never actually stores two rows
 * that could be confused.
 */
export interface RefreshTokenAad {
  gmailAccountId: string;
  kekVersion: string;
}

function aadBytes(aad: RefreshTokenAad): Uint8Array {
  // Length-prefixed, same collision reason canonicalSigningPayload() (auth/hmac.ts) is: a bare
  // delimiter-joined string collides whenever a field can itself contain the delimiter.
  return encoder.encode(
    [aad.gmailAccountId, aad.kekVersion].map((part) => `${part.length}:${part}`).join(''),
  );
}

/** A fresh, CSPRNG-random IV per call (`crypto.getRandomValues`, the platform CSPRNG in both the
 *  Workers runtime and Node's Web Crypto implementation) -- AES-GCM's confidentiality guarantee
 *  depends on IV uniqueness per key. This is a probabilistic guarantee, not an absolute one (NIST
 *  SP 800-38D's birthday-bound guidance caps safe random-IV usage at roughly 2^32 encryptions under
 *  one key before collision risk becomes non-negligible) -- acceptable here because a refresh token
 *  is only (re-)encrypted at connect-time and rotation-time, a handful of times per account
 *  lifetime (proposal §2.7), nowhere near that bound; a future caller encrypting far more
 *  frequently under the same key would need to revisit this. */
export async function encryptRefreshToken(
  kek: CryptoKey,
  refreshToken: string,
  aad: RefreshTokenAad,
): Promise<EncryptedRefreshToken> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadBytes(aad) },
    kek,
    encoder.encode(refreshToken),
  );
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}

/**
 * Throws (AES-GCM authentication failure, a `DOMException`/`OperationError`) if the ciphertext was
 * not produced under this exact key and this exact AAD -- a wrong `gmailAccountId`/`kekVersion`, a
 * wrong KEK, or a tampered ciphertext/IV all fail identically here rather than returning corrupted
 * plaintext.
 */
export async function decryptRefreshToken(
  kek: CryptoKey,
  encrypted: EncryptedRefreshToken,
  aad: RefreshTokenAad,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(encrypted.iv), additionalData: aadBytes(aad) },
    kek,
    base64ToBytes(encrypted.ciphertext),
  );
  return decoder.decode(plaintext);
}
