import type { D1Database } from '@cloudflare/workers-types';

export interface ProcessorEnv {
  DB: D1Database;
  MAX_PROCESSING_ATTEMPTS?: string;
  LEASE_DURATION_MS?: string;
  PROCESSOR_VERSION?: string;
}
