/* global Response */
import { describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_NOW,
  createTestD1,
  loadG3Schema,
  seedBaselineAccounts,
  seedEvent,
  seedOutbox,
} from '@pdos/testkit';
import { getEnrichment } from '@pdos/domain';
import type { GmailAIEnrichmentResult } from '@pdos/policy';

import { createGmailEventProcessor, queue } from '../src/index.js';
import { processMessage } from '../src/handler.js';

const COMPLETE: GmailAIEnrichmentResult = {
  outcome: 'COMPLETE',
  enrichment: {
    eventId: 'event-processor',
    modelId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    summary: {
      value: 'Review requested',
      provenance: ['event-processor'],
      derivation_method: 'AI_EXTRACTION',
      ai_policy: 'ALLOW',
      sensitivity: 'gmail-ai-derived',
      created_at: FIXTURE_NOW,
      derivation_version: 1,
    },
    signals: [],
  },
};

describe('GmailEventProcessor', () => {
  it('persists complete enrichment under the claimed lease before completing the event', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, { eventId: 'event-processor' });
    await seedOutbox(db, 'event-processor', { state: 'DISPATCHED', dispatchedAt: FIXTURE_NOW });
    let calls = 0;
    const processor = createGmailEventProcessor({
      db,
      engine: {
        enrich: async () => {
          calls += 1;
          return COMPLETE;
        },
      },
      now: () => FIXTURE_NOW,
    });

    const result = await processMessage(db, {
      eventId: 'event-processor',
      workerId: 'worker-gmail',
      now: FIXTURE_NOW,
      process: processor,
    });
    expect(result).toMatchObject({ claimed: true, transitioned: true });
    expect(calls).toBe(1);
    expect(await getEnrichment(db, 'event-processor')).toMatchObject({
      status: 'COMPLETE',
      summary: 'Review requested',
      modelId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    });
    expect(
      await db
        .prepare('SELECT state FROM ingest_events WHERE event_id = ?')
        .bind('event-processor')
        .first(),
    ).toEqual({ state: 'PROCESSED' });
  });

  it('uses the durable step-0 row and does not invoke AI again on retry', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, { eventId: 'event-processor' });
    await seedOutbox(db, 'event-processor', { state: 'DISPATCHED', dispatchedAt: FIXTURE_NOW });
    let calls = 0;
    const processor = createGmailEventProcessor({
      db,
      engine: {
        enrich: async () => {
          calls += 1;
          return COMPLETE;
        },
      },
      now: () => FIXTURE_NOW,
    });
    await processMessage(db, {
      eventId: 'event-processor',
      workerId: 'w1',
      now: FIXTURE_NOW,
      process: processor,
    });
    await db
      .prepare(
        'UPDATE ingest_events SET state = ?, processing_lease_owner = NULL, processing_lease_token = NULL WHERE event_id = ?',
      )
      .bind('ACCEPTED', 'event-processor')
      .run();
    await processMessage(db, {
      eventId: 'event-processor',
      workerId: 'w2',
      now: FIXTURE_NOW,
      process: processor,
    });
    expect(calls).toBe(1);
  });

  it('persists an explicit deleted marker and degrades disabled AI without a fabricated row', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, { eventId: 'event-deleted', eventType: 'MESSAGE_DELETED' });
    await seedOutbox(db, 'event-deleted', { state: 'DISPATCHED', dispatchedAt: FIXTURE_NOW });
    const deleted = createGmailEventProcessor({
      db,
      engine: { enrich: async () => ({ outcome: 'NO_CONTENT_DELETED' }) },
      now: () => FIXTURE_NOW,
    });
    expect(
      await processMessage(db, {
        eventId: 'event-deleted',
        workerId: 'wd',
        now: FIXTURE_NOW,
        process: deleted,
      }),
    ).toMatchObject({ transitioned: true });
    expect(await getEnrichment(db, 'event-deleted')).toMatchObject({
      status: 'NO_CONTENT_DELETED',
    });

    await seedEvent(db, accounts, { eventId: 'event-disabled' });
    await seedOutbox(db, 'event-disabled', { state: 'DISPATCHED', dispatchedAt: FIXTURE_NOW });
    const disabled = createGmailEventProcessor({
      db,
      engine: { enrich: async () => ({ outcome: 'DISABLED' }) },
    });
    expect(
      await processMessage(db, {
        eventId: 'event-disabled',
        workerId: 'wn',
        now: FIXTURE_NOW,
        process: disabled,
      }),
    ).toMatchObject({ transitioned: true });
    expect(await getEnrichment(db, 'event-disabled')).toBeNull();
  });

  it('queue production composition keeps Gmail deletion semantics when AI is absent', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    const eventId = '00000000-0000-4000-8000-000000000010';
    await seedEvent(db, accounts, { eventId, eventType: 'MESSAGE_DELETED' });
    await seedOutbox(db, eventId, { state: 'DISPATCHED', dispatchedAt: FIXTURE_NOW });
    const ack = vi.fn();
    await queue(
      {
        messages: [
          {
            id: 'queue-1',
            body: { event_id: eventId, operation: 'PROCESS_EVENT', schema_version: 4 },
            ack,
          },
        ],
      } as never,
      { DB: db },
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(await getEnrichment(db, eventId)).toMatchObject({ status: 'NO_CONTENT_DELETED' });
    expect(
      await db.prepare('SELECT state FROM ingest_events WHERE event_id = ?').bind(eventId).first(),
    ).toEqual({ state: 'PROCESSED' });
  });

  it('configured Gmail AI never routes a Telegram pointer to Gmail gateway or Workers AI', async () => {
    const db = createTestD1(loadG3Schema());
    const accounts = await seedBaselineAccounts(db);
    const eventId = '00000000-0000-4000-8000-000000000011';
    await seedEvent(db, accounts, { eventId, source: 'telegram' });
    await seedOutbox(db, eventId, { state: 'DISPATCHED', dispatchedAt: FIXTURE_NOW });
    const gatewayFetch = vi.fn(async () => new Response('{}', { status: 500 }));
    const aiRun = vi.fn(async () => ({ response: '{}' }));
    const ack = vi.fn();
    await queue(
      {
        messages: [
          {
            id: 'queue-telegram',
            body: { event_id: eventId, operation: 'PROCESS_EVENT', schema_version: 4 },
            ack,
          },
        ],
      } as never,
      {
        DB: db,
        GMAIL_CONTENT_GATEWAY: { fetch: gatewayFetch } as never,
        WORKERS_AI: { run: aiRun } as never,
        GMAIL_CONTENT_ATTESTATION_PUBLIC_JWK: JSON.stringify({
          kty: 'EC',
          crv: 'P-256',
          x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        }),
      },
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
    expect(await getEnrichment(db, eventId)).toBeNull();
    expect(
      await db.prepare('SELECT state FROM ingest_events WHERE event_id = ?').bind(eventId).first(),
    ).toEqual({ state: 'PROCESSED' });
  });
});
