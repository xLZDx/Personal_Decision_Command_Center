const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Constant-time-safe HMAC-SHA256 verification via Web Crypto (`crypto.subtle`), available
 * identically in Node and the Cloudflare Workers runtime -- no extra dependency, and the same code
 * runs in tests and in production. `crypto.subtle.verify` itself is written to avoid short-circuit
 * timing leaks; hex-comparing two freshly-computed digests here would reintroduce exactly that, so
 * verification is done as an actual HMAC verify, not a digest-then-string-compare.
 */
export async function verifyHmacSignature(
  secret: string,
  payload: string,
  signatureHex: string,
): Promise<boolean> {
  if (!/^[0-9a-f]+$/i.test(signatureHex) || signatureHex.length % 2 !== 0) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signatureBytes = new Uint8Array(signatureHex.length / 2);
  for (let i = 0; i < signatureBytes.length; i++) {
    signatureBytes[i] = parseInt(signatureHex.substring(i * 2, i * 2 + 2), 16);
  }
  return crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(payload));
}

/** Test/connector-side helper for producing a valid signature -- not used by the verification
 *  boundary itself, which only ever verifies. */
export async function signHmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return toHex(signature);
}

/**
 * The canonical string a connector signs: method + path + timestamp + nonce + a hash of the body,
 * length-prefixed for the same collision reason `idempotencyKey()` is (packages/contracts/event.ts)
 * -- a delimiter-joined string collides whenever a field can contain the delimiter.
 */
export function canonicalSigningPayload(parts: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
}): string {
  return [parts.method, parts.path, parts.timestamp, parts.nonce, parts.bodyHash]
    .map((part) => `${part.length}:${part}`)
    .join('');
}

export async function sha256Hex(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(payload));
  return toHex(digest);
}

/** Rejects a request timestamp outside the accepted window around `now` -- bounds how long a
 *  captured, validly-signed request remains replayable even before the nonce check runs. */
export function isTimestampWithinWindow(timestamp: string, now: string, windowMs: number): boolean {
  const t = Date.parse(timestamp);
  const n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return false;
  return Math.abs(n - t) <= windowMs;
}
