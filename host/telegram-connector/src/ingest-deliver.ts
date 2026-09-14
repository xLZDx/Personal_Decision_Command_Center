/* global fetch, crypto, URL, Response, setTimeout, clearTimeout, AbortController */
import { canonicalSigningPayload, sha256Hex, signHmac } from '@pdos/domain';
import { NormalizedEventSchema, type NormalizedEvent } from '@pdos/contracts';

export interface TelegramIngestDeliverOptions {
  endpoint: string;
  keyVersion: string;
  hmacSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => string;
  nonce?: () => string;
  timeoutMs?: number;
}

/** Builds the connector-side HMAC envelope used by POST /ingest/telegram. */
export function createTelegramIngestDeliver(options: TelegramIngestDeliverOptions): (event: NormalizedEvent) => Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpointUrl = new URL(options.endpoint);
  if (endpointUrl.protocol !== 'https:') throw new Error('Telegram ingest endpoint must use HTTPS');
  const now = options.now ?? (() => new Date().toISOString());
  const nonce = options.nonce ?? (() => crypto.randomUUID());
  const path = `${endpointUrl.pathname}${endpointUrl.search}`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error('timeoutMs must be between 100 and 120000');
  return async (event) => {
    const normalized = NormalizedEventSchema.parse(event);
    const body = JSON.stringify(normalized);
    const timestamp = now();
    const requestNonce = nonce();
    const bodyHash = await sha256Hex(body);
    const signingPayload = canonicalSigningPayload({
      method: 'POST', path, timestamp, nonce: requestNonce, bodyHash,
    });
    const signature = await signHmac(options.hmacSecret, signingPayload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-key-version': options.keyVersion,
          'x-timestamp': timestamp,
          'x-nonce': requestNonce,
          'x-signature': signature,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`Telegram ingest rejected (${response.status})`);
  };
}
