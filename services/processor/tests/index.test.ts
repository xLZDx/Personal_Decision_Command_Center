import { describe, expect, it, vi } from 'vitest';
import {
  createTestD1,
  loadG2Schema,
  seedBaselineAccounts,
  seedEvent,
  seedOutbox,
} from '@pdos/testkit';

import handler from '../src/index.js';
import type { ProcessorEnv } from '../src/env.js';
import { noopProcessor } from '../src/processor.js';

describe('noopProcessor', () => {
  it('always reports SUCCESS', async () => {
    await expect(noopProcessor({ eventId: 'x', attemptNumber: 1 })).resolves.toEqual({
      outcome: 'SUCCESS',
    });
  });
});

describe('queue handler', () => {
  it('acks every message after processing it, even when the batch has more than one', async () => {
    const db = createTestD1(loadG2Schema());
    const accounts = await seedBaselineAccounts(db);
    for (const id of ['ev-1', 'ev-2']) {
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
          body: { eventId: 'ev-1' },
          attempts: 1,
          retry: vi.fn(),
          ack: ack1,
        },
        {
          id: 'm2',
          timestamp: new Date(),
          body: { eventId: 'ev-2' },
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
      { event_id: 'ev-1', state: 'PROCESSED' },
      { event_id: 'ev-2', state: 'PROCESSED' },
    ]);
  });
});
