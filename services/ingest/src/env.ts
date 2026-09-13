import type { D1Database, Queue } from '@cloudflare/workers-types';

export interface DispatchMessage {
  eventId: string;
}

/**
 * Static Workers bindings (wrangler.toml / `wrangler secret put`). A new connector or key version
 * is a new secret binding here plus a wrangler.toml entry -- never a code change: `resolveSecret`
 * derives the expected binding name by convention (`<CONNECTOR>_<KEYVERSION>_HMAC_SECRET`), so the
 * ingest-authentication boundary in `packages/domain` stays generic even though Workers bindings
 * themselves are necessarily static.
 */
export interface IngestEnv {
  DB: D1Database;
  INGEST_QUEUE: Queue<DispatchMessage>;
  GMAIL_V1_HMAC_SECRET?: string;
  TELEGRAM_V1_HMAC_SECRET?: string;
  /** Runtime-configurable, always <= the schema's absolute ceiling (HARD_BUDGET_CEILING). */
  QUEUE_BUDGET_CAP?: string;
  MAX_PROCESSING_ATTEMPTS?: string;
  RECONCILER_BATCH_SIZE?: string;
  LEASE_RECOVERY_BATCH_SIZE?: string;
  HMAC_TIMESTAMP_WINDOW_MS?: string;
}

export function resolveSecret(
  env: IngestEnv,
  connectorId: string,
  keyVersion: string,
): string | undefined {
  const bindingName = `${connectorId.toUpperCase()}_${keyVersion.toUpperCase()}_HMAC_SECRET`;
  const record = env as unknown as Record<string, string | undefined>;
  return record[bindingName];
}
