import { describe, expect, it, vi } from 'vitest';
import {
  createTestD1,
  loadG2Schema,
  seedBaselineAccounts,
  seedSigningKey,
  TEST_HMAC_SECRET,
} from '@pdos/testkit';
import { canonicalSigningPayload, sha256Hex, signHmac } from '@pdos/domain';
import { SCHEMA_VERSION } from '@pdos/contracts';

import { handleIngestRequest, handleScheduled } from '../src/handler.js';
import type { IngestEnv } from '../src/env.js';

const NOW = '2026-09-13T00:00:00.000Z';

async function setupEnv(): Promise<{ env: IngestEnv; send: ReturnType<typeof vi.fn> }> {
  const db = createTestD1(loadG2Schema());
  await seedBaselineAccounts(db);
  await seedSigningKey(db, {
    connectorId: 'gmail',
    keyVersion: 'v1',
    status: 'ACTIVE',
    validFrom: '2026-09-01T00:00:00.000Z',
    validUntil: null,
  });
  const send = vi.fn().mockResolvedValue(undefined);
  const env: IngestEnv = {
    DB: db,
    INGEST_QUEUE: { send } as unknown as IngestEnv['INGEST_QUEUE'],
    GMAIL_V1_HMAC_SECRET: TEST_HMAC_SECRET,
  };
  return { env, send };
}

async function signedRequest(opts: {
  path: string;
  bodyObject: unknown;
  timestamp?: string;
  nonce?: string;
  secret?: string;
  keyVersion?: string;
  omitHeaders?: string[];
}): Promise<Request> {
  const bodyText = JSON.stringify(opts.bodyObject);
  const bodyHash = await sha256Hex(bodyText);
  const timestamp = opts.timestamp ?? NOW;
  const nonce = opts.nonce ?? 'nonce-1';
  const payload = canonicalSigningPayload({
    method: 'POST',
    path: opts.path,
    timestamp,
    nonce,
    bodyHash,
  });
  const signatureHex = await signHmac(opts.secret ?? TEST_HMAC_SECRET, payload);

  const headers = new Headers({
    'x-signature': signatureHex,
    'x-timestamp': timestamp,
    'x-nonce': nonce,
    'x-key-version': opts.keyVersion ?? 'v1',
  });
  for (const name of opts.omitHeaders ?? []) headers.delete(name);

  return new Request(`https://ingest.example${opts.path}`, {
    method: 'POST',
    headers,
    body: bodyText,
  });
}

function gmailEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    source: 'gmail',
    source_account_id: 'acc-gmail-test',
    source_event_id: 'msg-abc123',
    source_thread_id: null,
    event_type: 'MESSAGE_CREATED',
    direction: 'INBOUND',
    occurred_at: '2026-09-13T00:00:00.000Z',
    received_at: '2026-09-13T00:00:01.000Z',
    content_locator: { kind: 'SOURCE_REF', ref: 'gmail:msg-abc123' },
    routing_hints: [],
    source_policy_id: 'pol-gmail-allow',
    trace_id: 'trace-1',
    schema_version: SCHEMA_VERSION,
    source_version: null,
    ...overrides,
  };
}

describe('handleIngestRequest', () => {
  it('accepts a valid, correctly signed request', async () => {
    const { env } = await setupEnv();
    const request = await signedRequest({ path: '/ingest/gmail', bodyObject: gmailEvent() });
    const response = await handleIngestRequest(request, env, NOW);
    expect(response.status).toBe(202);
    const body = (await response.json()) as { status: string; eventId: string };
    expect(body.status).toBe('ACCEPTED');
  });

  it('404s for an unknown connector path', async () => {
    const { env } = await setupEnv();
    const request = await signedRequest({ path: '/ingest/slack', bodyObject: gmailEvent() });
    const response = await handleIngestRequest(request, env, NOW);
    expect(response.status).toBe(404);
  });

  it('401s when an auth header is missing', async () => {
    const { env } = await setupEnv();
    const request = await signedRequest({
      path: '/ingest/gmail',
      bodyObject: gmailEvent(),
      omitHeaders: ['x-signature'],
    });
    const response = await handleIngestRequest(request, env, NOW);
    expect(response.status).toBe(401);
  });

  it('401s for an unknown key version (no matching secret binding)', async () => {
    const { env } = await setupEnv();
    const request = await signedRequest({
      path: '/ingest/gmail',
      bodyObject: gmailEvent(),
      keyVersion: 'v99',
    });
    const response = await handleIngestRequest(request, env, NOW);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('UNKNOWN_KEY');
  });

  it('401s for a bad signature', async () => {
    const { env } = await setupEnv();
    const request = await signedRequest({
      path: '/ingest/gmail',
      bodyObject: gmailEvent(),
      secret: 'wrong-secret',
    });
    const response = await handleIngestRequest(request, env, NOW);
    expect(response.status).toBe(401);
  });

  it('401s a replayed nonce, even with an otherwise-identical valid request', async () => {
    const { env } = await setupEnv();
    const request1 = await signedRequest({ path: '/ingest/gmail', bodyObject: gmailEvent() });
    const first = await handleIngestRequest(request1, env, NOW);
    expect(first.status).toBe(202);

    const request2 = await signedRequest({ path: '/ingest/gmail', bodyObject: gmailEvent() });
    const second = await handleIngestRequest(request2, env, NOW);
    expect(second.status).toBe(401);
  });

  it('400s when the body claims a source different from the URL connector (credential/source mismatch)', async () => {
    const { env } = await setupEnv();
    const request = await signedRequest({
      path: '/ingest/gmail',
      bodyObject: gmailEvent({ source: 'telegram' }),
    });
    const response = await handleIngestRequest(request, env, NOW);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('SOURCE_MISMATCH');
  });

  it('400s a structurally invalid event without leaking any field value', async () => {
    const { env } = await setupEnv();
    const request = await signedRequest({
      path: '/ingest/gmail',
      bodyObject: gmailEvent({ body: 'a secret message body' }),
    });
    const response = await handleIngestRequest(request, env, NOW);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain('a secret message body');
  });

  it('is idempotent end-to-end: the same event submitted twice (fresh nonce each time) is accepted once', async () => {
    const { env } = await setupEnv();
    const request1 = await signedRequest({
      path: '/ingest/gmail',
      bodyObject: gmailEvent(),
      nonce: 'nonce-a',
    });
    const first = await handleIngestRequest(request1, env, NOW);
    expect(first.status).toBe(202);

    const request2 = await signedRequest({
      path: '/ingest/gmail',
      bodyObject: gmailEvent({ event_id: 'a3f8a6de-96db-4b53-9a34-6a9f6e6b6a11' }),
      nonce: 'nonce-b',
    });
    const second = await handleIngestRequest(request2, env, NOW);
    expect(second.status).toBe(200);
    const body = (await second.json()) as { status: string };
    expect(body.status).toBe('ALREADY_ACCEPTED');
  });
});

describe('handleScheduled', () => {
  it('dispatches eligible work and sends exactly one Queue message per dispatched event', async () => {
    const { env, send } = await setupEnv();
    const request = await signedRequest({ path: '/ingest/gmail', bodyObject: gmailEvent() });
    await handleIngestRequest(request, env, NOW);

    const result = await handleScheduled(env, '2026-09-13T00:05:00.000Z');
    expect(result.dispatch.dispatched).toEqual([gmailEvent().event_id]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ eventId: gmailEvent().event_id });
  });

  it('reports an empty run when there is nothing due', async () => {
    const { env, send } = await setupEnv();
    const result = await handleScheduled(env, NOW);
    expect(result).toEqual({
      leaseRecovery: [],
      dispatch: { dispatched: [], budgetExhausted: false },
    });
    expect(send).not.toHaveBeenCalled();
  });
});
