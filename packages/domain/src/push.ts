import { z } from 'zod';

const OpaquePushSchema = z
  .object({
    version: z.literal(1),
    notificationId: z.string().uuid(),
    cursor: z.string().min(1).max(256),
    nonce: z.string().uuid(),
  })
  .strict();

export type OpaquePushPayload = z.infer<typeof OpaquePushSchema>;
export const MAX_OPAQUE_PUSH_BYTES = 2048;

/** Builds a payload that contains only opaque identifiers/cursors, never title/body/content. */
export function createOpaquePushPayload(notificationId: string, cursor: string): string {
  const value = OpaquePushSchema.parse({
    version: 1,
    notificationId,
    cursor,
    nonce: cryptoRandomUuid(),
  });
  const encoded = encodeBase64Url(utf8Encode(JSON.stringify(value)));
  if (utf8Encode(encoded).byteLength > MAX_OPAQUE_PUSH_BYTES) {
    throw new Error('opaque push payload exceeds size cap');
  }
  return encoded;
}

export function decodeOpaquePushPayload(encoded: string): OpaquePushPayload {
  if (encoded.length > MAX_OPAQUE_PUSH_BYTES)
    throw new Error('opaque push payload exceeds size cap');
  let decoded: unknown;
  try {
    decoded = JSON.parse(utf8Decode(decodeBase64Url(encoded)));
  } catch {
    throw new Error('opaque push payload is invalid');
  }
  return OpaquePushSchema.parse(decoded);
}

function cryptoRandomUuid(): string {
  const cryptoApi = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  throw new Error('crypto.randomUUID is unavailable');
}

function encodeBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (value) => String.fromCharCode(value)).join('');
  const encode = (globalThis as unknown as { btoa: (input: string) => string }).btoa;
  return encode(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const decode = (globalThis as unknown as { atob: (input: string) => string }).atob;
  const binary = decode(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function utf8Encode(value: string): Uint8Array {
  const Encoder = (
    globalThis as unknown as {
      TextEncoder: new () => { encode(input: string): Uint8Array };
    }
  ).TextEncoder;
  return new Encoder().encode(value);
}

function utf8Decode(value: Uint8Array): string {
  const Decoder = (
    globalThis as unknown as {
      TextDecoder: new () => { decode(input: Uint8Array): string };
    }
  ).TextDecoder;
  return new Decoder().decode(value);
}

/** A push is merely a hint; any cursor gap requires authoritative resume/open synchronization. */
export function requiresResumeSync(lastSeenCursor: string | null, notifiedCursor: string): boolean {
  if (lastSeenCursor === null) return true;
  return lastSeenCursor !== notifiedCursor;
}
