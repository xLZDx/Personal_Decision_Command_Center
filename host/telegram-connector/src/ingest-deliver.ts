/* global fetch, crypto, URL */
import { canonicalSigningPayload, sha256Hex, signHmac } from '@pdos/domain';
import type { NormalizedEvent } from '@pdos/contracts';

export interface TelegramIngestDeliverOptions {
  endpoint: string;
  keyVersion: string;
  hmacSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => string;
  nonce?: () => string;
}

/** Builds the connector-side HMAC envelope used by POST /ingest/telegram. */
export function createTelegramIngestDeliver(options: TelegramIngestDeliverOptions): (event: NormalizedEvent) => Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date().toISOString());
  const nonce = options.nonce ?? (() => crypto.randomUUID());
  const url = new URL(options.endpoint);
  const path = `${url.pathname}${url.search}`;
  return async (event) => {
    const body = JSON.stringify(event);
    const timestamp = now();
    const requestNonce = nonce();
    const bodyHash = await sha256Hex(body);
    const signingPayload = canonicalSigningPayload({
      method: 'POST', path, timestamp, nonce: requestNonce, bodyHash,
    });
    const signature = await signHmac(options.hmacSecret, signingPayload);
    const response = await fetchImpl(options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-key-version': options.keyVersion,
        'x-timestamp': timestamp,
        'x-nonce': requestNonce,
        'x-signature': signature,
      },
      body,
    });
    if (!response.ok) throw new Error(`Telegram ingest rejected (${response.status})`);
  };
}
