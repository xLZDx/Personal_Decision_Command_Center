import type { D1Database, Queue } from '@cloudflare/workers-types';
import type { QueuePayload } from '@pdos/contracts';

/**
 * Static Workers bindings (wrangler.toml / `wrangler secret put`). A new connector or key version
 * is a new secret binding here plus a wrangler.toml entry -- never a code change: `resolveSecret`
 * derives the expected binding name by convention (`<CONNECTOR>_<KEYVERSION>_HMAC_SECRET`), so the
 * ingest-authentication boundary in `packages/domain` stays generic even though Workers bindings
 * themselves are necessarily static.
 */
export interface IngestEnv {
  DB: D1Database;
  INGEST_QUEUE: Queue<QueuePayload>;
  GMAIL_V1_HMAC_SECRET?: string;
  TELEGRAM_V1_HMAC_SECRET?: string;
  /** Runtime-configurable, always <= the schema's absolute ceiling (HARD_BUDGET_CEILING). */
  QUEUE_BUDGET_CAP?: string;
  MAX_PROCESSING_ATTEMPTS?: string;
  RECONCILER_BATCH_SIZE?: string;
  LEASE_RECOVERY_BATCH_SIZE?: string;
  HMAC_TIMESTAMP_WINDOW_MS?: string;
  REDISPATCH_TIMEOUT_MS?: string;
}

export interface ResolveSecretOptions {
  connectorId: string;
  keyVersion: string;
}

export function resolveSecret(env: IngestEnv, opts: ResolveSecretOptions): string | undefined {
  const bindingName = `${opts.connectorId.toUpperCase()}_${opts.keyVersion.toUpperCase()}_HMAC_SECRET`;
  const record = env as unknown as Record<string, string | undefined>;
  return record[bindingName];
}
