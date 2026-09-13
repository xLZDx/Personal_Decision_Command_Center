/* global AbortController */
import { describe, expect, it, vi } from 'vitest';
import {
  createTestD1,
  loadG2Schema,
  seedBaselineAccounts,
  seedEvent,
  seedOutbox,
} from '@pdos/testkit';
import { SCHEMA_VERSION } from '@pdos/contracts';

import handler from '../src/index.js';
import type { ProcessorEnv } from '../src/env.js';
import { noopProcessor } from '../src/processor.js';

describe('noopProcessor', () => {
  it('always reports SUCCESS', async () => {
    await expect(
      noopProcessor({
        eventId: 'x',
        attemptNumber: 1,
        leaseToken: 'token-x',
        leaseLost: new AbortController().signal,
      }),
    ).resolves.toEqual({
      outcome: 'SUCCESS',
    });
  });
});

const EV_1 = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const EV_2 = 'a3f8a6de-96db-4b53-9a34-6a9f6e6b6a11';

describe('queue handler', () => {
  it('acks every message after processing it, even when the batch has more than one', async () => {
    const db = createTestD1(loadG2Schema());
    const accounts = await seedBaselineAccounts(db);
    for (const id of [EV_1, EV_2]) {
      await seedEvent(db, accounts, { eventId: id, state: 'ACCEPTED' });
      await seedOutbox(db, id, { state: 'DISPATCHED', dispatchedAt: '2026-09-13T00:00:00.000Z' });
    }

    const ack1 = vi.fn();
    const ack2 = vi.fn();
    const batch = {
      messages: [
        {
          id: 'm1',
          timestamp: new Date(),
          body: { event_id: EV_1, operation: 'PROCESS_EVENT', schema_version: SCHEMA_VERSION },
          attempts: 1,
          retry: vi.fn(),
          ack: ack1,
        },
        {
          id: 'm2',
          timestamp: new Date(),
          body: { event_id: EV_2, operation: 'PROCESS_EVENT', schema_version: SCHEMA_VERSION },
          attempts: 1,
          retry: vi.fn(),
          ack: ack2,
        },
      ],
      queue: 'ingest-dispatch',
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    };

    const env: ProcessorEnv = { DB: db };
    await handler.queue!(batch as never, env);

    expect(ack1).toHaveBeenCalledTimes(1);
    expect(ack2).toHaveBeenCalledTimes(1);

    const states = await db
      .prepare('SELECT event_id, state FROM ingest_events ORDER BY event_id')
      .all<{ event_id: string; state: string }>();
    expect(states.results).toEqual([
      { event_id: EV_1, state: 'PROCESSED' },
      { event_id: EV_2, state: 'PROCESSED' },
    ]);
  });

  it('acks and skips a message that fails the QueuePayloadSchema wire contract, without touching D1', async () => {
    const db = createTestD1(loadG2Schema());
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, { eventId: EV_1, state: 'ACCEPTED' });
    await seedOutbox(db, EV_1, { state: 'DISPATCHED', dispatchedAt: '2026-09-13T00:00:00.000Z' });

    const ack = vi.fn();
    const batch = {
      // Not a valid UUID event_id, and an operation the schema does not recognize -- exactly the
      // shape a producer that had drifted from the published contract could send.
      messages: [
        {
          id: 'm1',
          timestamp: new Date(),
          body: { eventId: EV_1 },
          attempts: 1,
          retry: vi.fn(),
          ack,
        },
      ],
      queue: 'ingest-dispatch',
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    };

    const env: ProcessorEnv = { DB: db };
    await handler.queue!(batch as never, env);

    expect(ack).toHaveBeenCalledTimes(1);

    const event = await db
      .prepare('SELECT state FROM ingest_events WHERE event_id = ?')
      .bind(EV_1)
      .first<{ state: string }>();
    expect(event?.state).toBe('ACCEPTED');
  });
});
