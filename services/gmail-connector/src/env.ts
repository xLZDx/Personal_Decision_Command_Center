import type { Fetcher } from '@cloudflare/workers-types';

export interface GmailConnectorEnv {
  /** Internal adapter to Gmail API; this Worker owns OAuth/token exchange in later G3 checkpoints. */
  GMAIL_API: Fetcher;
  /** JSON ECDSA P-256 private JWK kept as a Worker Secret, never sent to processor/AI. */
  GMAIL_CONTENT_SIGNING_PRIVATE_JWK: string;
}
