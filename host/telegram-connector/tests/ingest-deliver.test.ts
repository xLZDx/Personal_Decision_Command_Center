/* global Headers, Response */
import { describe, expect, it } from 'vitest';
import { createTelegramIngestDeliver } from '../src/index.js';
import { canonicalSigningPayload, sha256Hex, verifyHmacSignature } from '@pdos/domain';

const event = {
  event_id: '00000000-0000-4000-8000-000000000081', source: 'telegram', source_account_id: 'tg',
  source_event_id: 'm81', source_thread_id: null, event_type: 'MESSAGE_CREATED', direction: 'INBOUND',
  occurred_at: '2026-09-14T10:01:00.000Z', occurred_at_quality: 'PROVIDER_REPORTED', received_at: '2026-09-14T10:00:00.000Z',
  content_locator: { kind: 'SOURCE_REF', ref: 'm81' }, routing_hints: [], source_policy_id: 'p', trace_id: 't81', schema_version: 4, source_version: null,
};

describe('createTelegramIngestDeliver', () => {
  it('signs the exact POST body and rejects non-2xx responses', async () => {
    let captured: { body: string; headers: Headers } | undefined;
    const deliver = createTelegramIngestDeliver({
      endpoint: 'https://ingest.example/ingest/telegram', keyVersion: 'v1', hmacSecret: 'test-secret',
      now: () => '2026-09-14T10:00:00.000Z', nonce: () => 'nonce-81',
      fetchImpl: async (_input, init) => {
        captured = { body: String(init?.body), headers: new Headers(init?.headers) };
        return new Response('{}', { status: 202 });
      },
    });
    await deliver(event as never);
    expect(captured).toBeDefined();
    const bodyHash = await sha256Hex(captured!.body);
    const payload = canonicalSigningPayload({ method: 'POST', path: '/ingest/telegram', timestamp: captured!.headers.get('x-timestamp')!, nonce: 'nonce-81', bodyHash });
    await expect(verifyHmacSignature('test-secret', payload, captured!.headers.get('x-signature')!)).resolves.toBe(true);
  });
});
