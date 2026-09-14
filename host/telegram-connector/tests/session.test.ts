import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '@pdos/contracts';

import { TelegramSession } from '../src/index.js';

const event = (occurred_at: string): NormalizedEvent => ({
  event_id: '00000000-0000-4000-8000-000000000031',
  source: 'telegram',
  source_account_id: 'tg-account',
  source_event_id: 'tg-message-31',
  source_thread_id: null,
  event_type: 'MESSAGE_CREATED',
  direction: 'INBOUND',
  occurred_at,
  occurred_at_quality: 'PROVIDER_REPORTED',
  received_at: '2026-09-14T10:00:00.000Z',
  content_locator: { kind: 'SOURCE_REF', ref: 'tg-message-31' },
  routing_hints: [],
  source_policy_id: 'tg-policy',
  trace_id: 'trace-31',
  schema_version: 4,
  source_version: null,
});

describe('TelegramSession', () => {
  it('does not centrally emit initial TDLib cache and starts at connected_at', async () => {
    const emitted: NormalizedEvent[] = [];
    const session = new TelegramSession({
      now: () => '2026-09-14T10:00:00.000Z',
      emit: async (value) => {
        emitted.push(value);
      },
    });
    session.onAuthorizationState('READY');
    expect(
      await session.onMessage({ event: event('2026-09-13T10:00:00.000Z'), initialCache: true }),
    ).toBe(false);
    expect(
      await session.onMessage({ event: event('2026-09-14T10:01:00.000Z'), initialCache: false }),
    ).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(session.health().state).toBe('READY');
  });

  it('retains reconnect health state and suppresses updates while offline', async () => {
    const emitted: NormalizedEvent[] = [];
    const session = new TelegramSession({
      emit: async (value) => {
        emitted.push(value);
      },
    });
    session.onAuthorizationState('READY');
    session.onAuthorizationState('OFFLINE');
    expect(
      await session.onMessage({ event: event('2026-09-14T10:01:00.000Z'), initialCache: false }),
    ).toBe(false);
    expect(emitted).toHaveLength(0);
    expect(session.health().state).toBe('OFFLINE');
  });

  it('starts a fresh boundary after a reconnect beyond the six-hour soak window', async () => {
    const emitted: NormalizedEvent[] = [];
    let current = '2026-09-14T10:00:00.000Z';
    const session = new TelegramSession({
      now: () => current,
      emit: async (value) => {
        emitted.push(value);
      },
    });
    session.onAuthorizationState('READY');
    session.onAuthorizationState('OFFLINE');
    current = '2026-09-14T16:01:00.000Z';
    session.onAuthorizationState('READY');
    expect(session.health().connectedAt).toBe(current);
    expect(
      await session.onMessage({ event: event('2026-09-14T16:02:00.000Z'), initialCache: false }),
    ).toBe(true);
    expect(emitted).toHaveLength(1);
  });
});
