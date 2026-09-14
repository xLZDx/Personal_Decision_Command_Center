import { PushPayloadSchema, type PushPayload } from '@pdos/contracts';

export type OpaquePushPayload = PushPayload;
export const MAX_OPAQUE_PUSH_BYTES = 2048;

/** Builds the single contract-defined wire payload; it contains no cursor or source-derived text. */
export function createOpaquePushPayload(notificationId: string): string {
  const value = PushPayloadSchema.parse({
    type: 'STATE_CHANGED',
    notification_id: notificationId,
    schema_version: 1,
  });
  const encoded = JSON.stringify(value);
  if (encoded.length > MAX_OPAQUE_PUSH_BYTES)
    throw new Error('opaque push payload exceeds size cap');
  return encoded;
}

export function decodeOpaquePushPayload(encoded: string): OpaquePushPayload {
  if (encoded.length > MAX_OPAQUE_PUSH_BYTES)
    throw new Error('opaque push payload exceeds size cap');
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    throw new Error('opaque push payload is invalid');
  }
  return PushPayloadSchema.parse(decoded);
}

/** A push is merely a hint; any cursor gap requires authoritative resume/open synchronization. */
export function requiresResumeSync(lastSeenCursor: string | null, notifiedCursor: string): boolean {
  if (lastSeenCursor === null) return true;
  return lastSeenCursor !== notifiedCursor;
}
