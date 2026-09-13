import type { D1Database } from '@cloudflare/workers-types';

/** The Queue message shape `services/ingest` sends (its own `DispatchMessage`). Duplicated here,
 *  not imported cross-service: each Worker is independently deployable, and this is a one-field
 *  wire contract, not a shared abstraction worth a package for. */
export interface DispatchMessage {
  eventId: string;
}

export interface ProcessorEnv {
  DB: D1Database;
  MAX_PROCESSING_ATTEMPTS?: string;
  LEASE_DURATION_MS?: string;
  PROCESSOR_VERSION?: string;
}
