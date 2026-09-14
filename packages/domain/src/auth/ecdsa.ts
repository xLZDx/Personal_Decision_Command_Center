/* global crypto, TextEncoder, btoa, atob */
import type { webcrypto } from 'node:crypto';

type CryptoKey = webcrypto.CryptoKey;

/** Public verification material for the connector-to-policy content boundary. */
export interface EcdsaP256PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

const encoder = new TextEncoder();

function base64ToBytes(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return new Uint8Array();
  }
}

function bytesToBase64(value: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Verify a connector-produced P-256 ECDSA/SHA-256 signature using public material only. */
export async function verifyEcdsaP256Signature(
  publicJwk: EcdsaP256PublicJwk,
  payload: string,
  signatureBase64: string,
): Promise<boolean> {
  const signature = base64ToBytes(signatureBase64);
  if (signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      publicJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      encoder.encode(payload),
    );
  } catch {
    return false;
  }
}

/** Connector/test-side helper. The policy package never receives this private key. */
export async function signEcdsaP256Signature(
  privateKey: CryptoKey,
  payload: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    encoder.encode(payload),
  );
  return bytesToBase64(signature);
}
