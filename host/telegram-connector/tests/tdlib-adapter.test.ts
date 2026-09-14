import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '@pdos/contracts';

import { TelegramSession, TelegramTdlibAdapter } from '../src/index.js';

const event: NormalizedEvent = {
  event_id: '00000000-0000-4000-8000-000000000051',
  source: 'telegram',
  source_account_id: 'tg-account',
  source_event_id: 'tg-message-51',
  source_thread_id: null,
  event_type: 'MESSAGE_CREATED',
  direction: 'INBOUND',
  occurred_at: '2026-09-14T10:01:00.000Z',
  occurred_at_quality: 'PROVIDER_REPORTED',
  received_at: '2026-09-14T10:00:00.000Z',
  content_locator: { kind: 'SOURCE_REF', ref: 'tg-message-51' },
  routing_hints: [],
  source_policy_id: 'tg-policy',
  trace_id: 'trace-51',
  schema_version: 4,
  source_version: null,
};

describe('TelegramTdlibAdapter', () => {
  it('routes authorization and normalized updates through the session boundary', async () => {
    const emitted: NormalizedEvent[] = [];
    let authorization: ((state: 'WAITING' | 'READY' | 'OFFLINE' | 'CLOSED') => void) | undefined;
    let message: ((update: { event: NormalizedEvent; initialCache: boolean }) => void) | undefined;
    const session = new TelegramSession({
      now: () => '2026-09-14T10:00:00.000Z',
      emit: async (value) => {
        emitted.push(value);
      },
    });
    const adapter = new TelegramTdlibAdapter({
      source: {
        onAuthorizationState(listener) {
          authorization = listener;
          return () => {
            authorization = undefined;
          };
        },
        onMessage(listener) {
          message = listener;
          return () => {
            message = undefined;
          };
        },
      },
      session,
      normalizeMessage: (update) => update,
    });
    adapter.start();
    authorization?.('READY');
    message?.({ event, initialCache: false });
    await Promise.resolve();
    expect(emitted).toHaveLength(1);
    expect(adapter.health().state).toBe('READY');
    adapter.stop();
    expect(authorization).toBeUndefined();
    expect(message).toBeUndefined();
  });

  it('does not attach listeners twice', () => {
    let subscriptions = 0;
    const session = new TelegramSession({ emit: async () => {} });
    const adapter = new TelegramTdlibAdapter({
      source: {
        onAuthorizationState: () => {
          subscriptions++;
          return () => undefined;
        },
        onMessage: () => {
          subscriptions++;
          return () => undefined;
        },
      },
      session,
      normalizeMessage: (update) => update,
    });
    adapter.start();
    adapter.start();
    expect(subscriptions).toBe(2);
    adapter.stop();
  });
});
