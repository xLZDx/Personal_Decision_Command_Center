import type { D1Database } from '@cloudflare/workers-types';
import type { Fetcher } from '@cloudflare/workers-types';
import type { WorkersAiBinding } from '@pdos/policy';

export interface ProcessorEnv {
  DB: D1Database;
  MAX_PROCESSING_ATTEMPTS?: string;
  LEASE_DURATION_MS?: string;
  PROCESSOR_VERSION?: string;
  /** Explicit legacy-only switch for pre-G3 databases; never set in G3 production. */
  PROCESSOR_G2_COMPAT_MODE?: string;
  /** Internal service binding; it returns connector-signed, on-demand Gmail content envelopes. */
  GMAIL_CONTENT_GATEWAY?: Fetcher;
  /** Workers AI binding is optional so the safe AI-disabled composition remains deployable. */
  WORKERS_AI?: WorkersAiBinding;
  /** JSON-encoded ECDSA P-256 public JWK; private signing material stays in the connector. */
  GMAIL_CONTENT_ATTESTATION_PUBLIC_JWK?: string;
  GMAIL_REDACTION_SECRETS_JSON?: string;
}
