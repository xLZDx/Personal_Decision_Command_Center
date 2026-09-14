/* global Request, Headers */
import { describe, expect, it, vi } from 'vitest';
import type { Queue } from '@cloudflare/workers-types';
import {
  createTestD1,
  loadG2Schema,
  seedBaselineAccounts,
  seedSigningKey,
  TEST_HMAC_SECRET,
} from '@pdos/testkit';
import { canonicalSigningPayload, sha256Hex, signHmac } from '@pdos/domain';
import { SCHEMA_VERSION, type QueuePayload } from '@pdos/contracts';

import { handleIngestRequest, handleScheduled } from '@pdos/ingest-service';
import type { IngestEnv } from '@pdos/ingest-service';
import processorHandler from '@pdos/processor-service';
import type { ProcessorEnv } from '@pdos/processor-service';

/**
 * MAJOR fix (GPT-PM, G2 gate review round 2): round 1's regression tests each proved their own
 * fix's IMMEDIATE effect (a throwing send() doesn't abort the rest of the tick; a redispatch-due
 * row gets a new dispatch_count) but stopped there -- neither proved the pipeline actually recovers
 * to PROCESSED end to end. A redispatch implementation that mutates the outbox correctly but never
 * restores real processing could still pass those narrower tests. This is the missing scenario:
 * an event whose FIRST dispatch attempt is lost (Queue.send() throws right after the D1 dispatch
 * transition already committed) still reaches PROCESSED, once the reconciler's own redispatch-due
 * window elapses and a later tick's send succeeds.
 */

const NOW = '2026-09-13T00:00:00.000Z';
const EVENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function gmailEvent() {
  return {
    event_id: EVENT_ID,
    source: 'gmail',
    source_account_id: 'acc-gmail-test',
    source_event_id: 'msg-lost-send',
    source_thread_id: null,
    event_type: 'MESSAGE_CREATED',
    direction: 'INBOUND',
    occurred_at: NOW,
    received_at: NOW,
    content_locator: { kind: 'SOURCE_REF', ref: 'gmail:msg-lost-send' },
    routing_hints: [],
    source_policy_id: 'pol-gmail-allow',
    trace_id: 'trace-lost-send',
    schema_version: SCHEMA_VERSION,
    source_version: null,
  };
}

async function signedRequest(): Promise<Request> {
  const bodyText = JSON.stringify(gmailEvent());
  const bodyHash = await sha256Hex(bodyText);
  const nonce = 'nonce-lost-send';
  const payload = canonicalSigningPayload({
    method: 'POST',
    path: '/ingest/gmail',
    timestamp: NOW,
    nonce,
    bodyHash,
  });
  const signatureHex = await signHmac(TEST_HMAC_SECRET, payload);
  return new Request('https://ingest.example/ingest/gmail', {
    method: 'POST',
    headers: new Headers({
      'x-signature': signatureHex,
      'x-timestamp': NOW,
      'x-nonce': nonce,
      'x-key-version': 'v1',
    }),
    body: bodyText,
  });
}

describe('redispatch recovery end to end (GPT-PM MAJOR, G2 gate review round 2)', () => {
  it('an event whose first dispatch is lost (Queue.send() throws) still reaches PROCESSED after the reconciler redispatches it', async () => {
    const db = createTestD1(loadG2Schema());
    await seedBaselineAccounts(db);
    await seedSigningKey(db, {
      connectorId: 'gmail',
      keyVersion: 'v1',
      status: 'ACTIVE',
      validFrom: '2026-09-01T00:00:00.000Z',
      validUntil: null,
    });

    const send = vi.fn();
    send.mockRejectedValueOnce(new Error('simulated queue outage'));
    send.mockResolvedValue(undefined);
    const env: IngestEnv = {
      DB: db,
      INGEST_QUEUE: { send } as unknown as Queue<QueuePayload>,
      GMAIL_V1_HMAC_SECRET: TEST_HMAC_SECRET,
    };

    const request = await signedRequest();
    const ingestResponse = await handleIngestRequest(request, env, NOW);
    expect(ingestResponse.status).toBe(202);

    // Tick 1: the reconciler dispatches (D1 transition commits: DISPATCHED, dispatch_count = 1),
    // but the Queue send for it throws -- the D1 side of the dispatch is NOT rolled back.
    const tick1At = '2026-09-13T00:00:05.000Z';
    const tick1 = await handleScheduled(env, tick1At);
    expect(tick1.dispatch.dispatched).toEqual([EVENT_ID]);
    expect(tick1.sendFailures).toEqual([EVENT_ID]);

    const afterTick1 = await db
      .prepare('SELECT state, dispatch_count FROM processing_outbox WHERE event_id = ?')
      .bind(EVENT_ID)
      .first<{ state: string; dispatch_count: number }>();
    expect(afterTick1).toEqual({ state: 'DISPATCHED', dispatch_count: 1 });

    // Before the redispatch-due window elapses, a tick must NOT yet redispatch it.
    const tooSoonAt = '2026-09-13T00:02:00.000Z';
    const tooSoon = await handleScheduled(env, tooSoonAt);
    expect(tooSoon.dispatch.dispatched).toEqual([]);

    // Tick 2, past the default REDISPATCH_TIMEOUT_MS (5 minutes from tick1's dispatch time): the
    // row is treated as lost and redispatched -- this time the send succeeds.
    const tick2At = '2026-09-13T00:05:06.000Z';
    const tick2 = await handleScheduled(env, tick2At);
    expect(tick2.dispatch.dispatched).toEqual([EVENT_ID]);
    expect(tick2.sendFailures).toEqual([]);

    const afterTick2 = await db
      .prepare('SELECT state, dispatch_count FROM processing_outbox WHERE event_id = ?')
      .bind(EVENT_ID)
      .first<{ state: string; dispatch_count: number }>();
    expect(afterTick2).toEqual({ state: 'DISPATCHED', dispatch_count: 2 });

    expect(send).toHaveBeenCalledTimes(2);
    const successfulMessage = send.mock.calls[1]?.[0] as QueuePayload;
    expect(successfulMessage).toEqual({
      event_id: EVENT_ID,
      operation: 'PROCESS_EVENT',
      schema_version: SCHEMA_VERSION,
    });

    // Feed the ONE successfully-sent message into the real Queue consumer.
    const processorEnv: ProcessorEnv = { DB: db, PROCESSOR_G2_COMPAT_MODE: 'true' };
    const batch = {
      messages: [
        {
          id: 'm1',
          timestamp: new Date(),
          body: successfulMessage,
          attempts: 1,
          retry: () => undefined,
          ack: () => undefined,
        },
      ],
      queue: 'ingest-dispatch',
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: () => undefined,
      ackAll: () => undefined,
    };
    await processorHandler.queue!(batch as never, processorEnv);

    const finalEvent = await db
      .prepare('SELECT state FROM ingest_events WHERE event_id = ?')
      .bind(EVENT_ID)
      .first<{ state: string }>();
    expect(finalEvent?.state).toBe('PROCESSED');

    const finalOutbox = await db
      .prepare('SELECT state FROM processing_outbox WHERE event_id = ?')
      .bind(EVENT_ID)
      .first<{ state: string }>();
    expect(finalOutbox?.state).toBe('CLOSED');
  });
});
