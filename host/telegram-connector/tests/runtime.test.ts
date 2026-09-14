import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '@pdos/contracts';

import { TelegramConnectorRuntime, TelegramSpool } from '../src/index.js';

const event = (occurred_at: string): NormalizedEvent => ({
  event_id: '00000000-0000-4000-8000-000000000041',
  source: 'telegram',
  source_account_id: 'tg-account',
  source_event_id: 'tg-message-41',
  source_thread_id: null,
  event_type: 'MESSAGE_CREATED',
  direction: 'INBOUND',
  occurred_at,
  occurred_at_quality: 'PROVIDER_REPORTED',
  received_at: '2026-09-14T10:00:00.000Z',
  content_locator: { kind: 'SOURCE_REF', ref: 'tg-message-41' },
  routing_hints: [],
  source_policy_id: 'tg-policy',
  trace_id: 'trace-41',
  schema_version: 4,
  source_version: null,
});

function makeRuntime(deliver: (value: NormalizedEvent) => Promise<void>) {
  const spool = new TelegramSpool(join(tmpdir(), `pdos-tg-runtime-${randomUUID()}.sqlite`));
  const runtime = new TelegramConnectorRuntime({
    spool,
    deliver,
    now: () => '2026-09-14T10:00:00.000Z',
  });
  return { runtime, spool };
}

describe('TelegramConnectorRuntime', () => {
  it('durably enqueues eligible updates before ingest delivery and ACKs after success', async () => {
    const delivered: NormalizedEvent[] = [];
    const { runtime, spool } = makeRuntime(async (value) => {
      delivered.push(value);
    });
    runtime.session().onAuthorizationState('READY');
    expect(
      await runtime.onMessage({ event: event('2026-09-14T10:01:00.000Z'), initialCache: false }),
    ).toBe(true);
    const result = await runtime.drainOnce();
    expect(result.outcome).toBe('ACKED');
    expect(delivered).toHaveLength(1);
    expect(await runtime.drainOnce()).toEqual({ outcome: 'EMPTY' });
    spool.close();
  });

  it('keeps retryable failures in the spool and marks permanent failures terminal', async () => {
    const deliver = vi
      .fn<(value: NormalizedEvent) => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockRejectedValueOnce(Object.assign(new Error('bad request'), { code: 'PERMANENT' }));
    const { runtime, spool } = makeRuntime(deliver);
    runtime.session().onAuthorizationState('READY');
    await runtime.onMessage({ event: event('2026-09-14T10:01:00.000Z'), initialCache: false });
    expect((await runtime.drainOnce()).outcome).toBe('FAILED_RETRYABLE');
    expect((await runtime.drainOnce()).outcome).toBe('EMPTY');

    const retryRuntime = new TelegramConnectorRuntime({
      spool,
      deliver,
      now: () => '2026-09-14T10:00:02.000Z',
      isPermanentError: (error) => (error as { code?: string }).code === 'PERMANENT',
    });
    expect((await retryRuntime.drainOnce()).outcome).toBe('FAILED_PERMANENT');
    expect(await retryRuntime.drainOnce()).toEqual({ outcome: 'EMPTY' });
    spool.close();
  });
});
