import { describe, expect, it } from 'vitest';
import {
  createTestD1,
  loadG2Schema,
  seedBaselineAccounts,
  seedEvent,
  seedOutbox,
} from '@pdos/testkit';

import { processMessage } from '../src/handler.js';
import type { EventProcessor } from '../src/processor.js';

const NOW = '2026-09-13T00:00:00.000Z';

async function setupAccepted(eventId: string) {
  const db = createTestD1(loadG2Schema());
  const accounts = await seedBaselineAccounts(db);
  await seedEvent(db, accounts, { eventId, state: 'ACCEPTED' });
  await seedOutbox(db, eventId, { state: 'DISPATCHED', dispatchedAt: NOW });
  return db;
}

describe('processMessage', () => {
  it('claims, processes successfully, and completes the event', async () => {
    const db = await setupAccepted('ev-1');
    const succeed: EventProcessor = async () => ({ outcome: 'SUCCESS' });

    const result = await processMessage(db, {
      eventId: 'ev-1',
      workerId: 'worker-1',
      now: NOW,
      process: succeed,
    });
    expect(result).toEqual({ claimed: true, transitioned: true });

    const event = await db
      .prepare('SELECT state FROM ingest_events WHERE event_id = ?')
      .bind('ev-1')
      .first<{ state: string }>();
    expect(event?.state).toBe('PROCESSED');
  });

  it('defaults to the no-op processor (always SUCCESS) when none is injected', async () => {
    const db = await setupAccepted('ev-2');
    const result = await processMessage(db, { eventId: 'ev-2', workerId: 'worker-1', now: NOW });
    expect(result).toEqual({ claimed: true, transitioned: true });
  });

  it('a thrown processor exception is treated as RETRYABLE_FAILURE, releasing the lease', async () => {
    const db = await setupAccepted('ev-3');
    const throwing: EventProcessor = async () => {
      throw new Error('boom');
    };
    const result = await processMessage(db, {
      eventId: 'ev-3',
      workerId: 'worker-1',
      now: NOW,
      process: throwing,
    });
    expect(result).toEqual({ claimed: true, transitioned: true, movedToDlq: false });

    const event = await db
      .prepare('SELECT state, processing_lease_token FROM ingest_events WHERE event_id = ?')
      .bind('ev-3')
      .first<{ state: string; processing_lease_token: string | null }>();
    expect(event).toEqual({ state: 'RETRYABLE_FAILED', processing_lease_token: null });
  });

  it('an explicit PERMANENT_FAILURE goes straight to DLQ, below the attempt cap', async () => {
    const db = await setupAccepted('ev-4');
    const permanentFail: EventProcessor = async () => ({
      outcome: 'PERMANENT_FAILURE',
      errorClass: 'ValidationError',
      errorCode: 'E_INVALID',
    });
    const result = await processMessage(db, {
      eventId: 'ev-4',
      workerId: 'worker-1',
      now: NOW,
      process: permanentFail,
    });
    expect(result).toEqual({ claimed: true, transitioned: true, movedToDlq: true });
  });

  it('does not claim (and does not run the processor) a row already PROCESSING under a live lease', async () => {
    const db = await setupAccepted('ev-5');
    let calls = 0;
    const countingProcessor: EventProcessor = async () => {
      calls++;
      return { outcome: 'SUCCESS' };
    };

    const first = await processMessage(db, {
      eventId: 'ev-5',
      workerId: 'worker-1',
      now: NOW,
      process: countingProcessor,
    });
    expect(first.claimed).toBe(true);

    // A second, concurrent/duplicate delivery of the SAME dispatch (Cloudflare Queue's
    // at-least-once guarantee) must be a safe no-op, not a second processing run.
    const second = await processMessage(db, {
      eventId: 'ev-5',
      workerId: 'worker-2',
      now: '2026-09-13T00:00:01.000Z',
      process: countingProcessor,
    });
    expect(second).toEqual({ claimed: false });
    expect(calls).toBe(1);
  });

  it('escalating attempts respects the configured maxAttempts cap', async () => {
    const db = createTestD1(loadG2Schema());
    const accounts = await seedBaselineAccounts(db);
    await seedEvent(db, accounts, {
      eventId: 'ev-6',
      state: 'RETRYABLE_FAILED',
      attemptCount: 4,
      firstFailedAt: NOW,
    });
    await seedOutbox(db, 'ev-6', { state: 'RETRY_PENDING' });

    const alwaysFail: EventProcessor = async () => ({
      outcome: 'RETRYABLE_FAILURE',
      errorClass: 'NetworkError',
      errorCode: 'E_NET',
    });
    // This is the 5th attempt -- at the default maxAttempts (5), it must go to DLQ, not loop again.
    const result = await processMessage(db, {
      eventId: 'ev-6',
      workerId: 'worker-1',
      now: NOW,
      process: alwaysFail,
    });
    expect(result).toEqual({ claimed: true, transitioned: true, movedToDlq: true });
  });
});
