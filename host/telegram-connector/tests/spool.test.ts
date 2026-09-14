import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type NormalizedEvent } from '@pdos/contracts';

import { TelegramSpool } from '../src/index.js';

function event(id: string): NormalizedEvent {
  return {
    event_id: id,
    source: 'telegram' as const,
    source_account_id: 'tg-account',
    source_event_id: `source-${id}`,
    source_thread_id: null,
    event_type: 'MESSAGE_CREATED' as const,
    direction: 'INBOUND' as const,
    occurred_at: '2026-09-14T00:00:00.000Z',
    occurred_at_quality: 'PROVIDER_REPORTED' as const,
    received_at: '2026-09-14T00:00:00.000Z',
    content_locator: { kind: 'SOURCE_REF' as const, ref: 'telegram-message-opaque' },
    routing_hints: [],
    source_policy_id: 'tg-policy',
    trace_id: `trace-${id}`,
    schema_version: SCHEMA_VERSION,
    source_version: null,
  };
}

describe('TelegramSpool', () => {
  it('survives restart and deduplicates event enqueue', () => {
    const path = join(tmpdir(), `pdos-tg-${randomUUID()}.sqlite`);
    const now = '2026-09-14T00:00:00.000Z';
    const first = new TelegramSpool(path);
    expect(first.enqueue(event('00000000-0000-4000-8000-000000000021'), now)).toBe(true);
    expect(first.enqueue(event('00000000-0000-4000-8000-000000000021'), now)).toBe(false);
    first.close();
    const second = new TelegramSpool(path);
    expect(second.claimReady(now)?.event.content_locator.ref).toBe('telegram-message-opaque');
    second.close();
  });

  it('tracks retryable/permanent outcomes without changing the event envelope', () => {
    const path = join(tmpdir(), `pdos-tg-${randomUUID()}.sqlite`);
    const now = '2026-09-14T00:00:00.000Z';
    const spool = new TelegramSpool(path, { random: () => 0 });
    spool.enqueue(event('00000000-0000-4000-8000-000000000022'), now);
    const item = spool.claimReady(now)!;
    spool.fail(item.id, now, false, item.leaseToken);
    expect(spool.claimReady(now)).toBeNull();
    const retry = spool.claimReady('2026-09-14T00:00:02.000Z')!;
    spool.fail(retry.id, '2026-09-14T00:00:02.000Z', true, retry.leaseToken);
    expect(spool.claimReady('2026-09-14T00:00:03.000Z')).toBeNull();
    spool.close();
  });

  it('uses bounded exponential retry with injected jitter', () => {
    const path = join(tmpdir(), `pdos-tg-${randomUUID()}.sqlite`);
    const spool = new TelegramSpool(path, {
      retryBaseMs: 1_000,
      retryCapMs: 2_500,
      random: () => 1,
    });
    const now = '2026-09-14T00:00:00.000Z';
    spool.enqueue(event('00000000-0000-4000-8000-000000000023'), now);
    const item = spool.claimReady(now)!;
    spool.fail(item.id, now, false, item.leaseToken);
    expect(spool.claimReady('2026-09-14T00:00:01.199Z')).toBeNull();
    const retry = spool.claimReady('2026-09-14T00:00:01.200Z')!;
    expect(retry).not.toBeNull();
    spool.fail(retry.id, '2026-09-14T00:00:01.200Z', false, retry.leaseToken);
    expect(spool.claimReady('2026-09-14T00:00:03.599Z')).toBeNull();
    expect(spool.claimReady('2026-09-14T00:00:03.700Z')).not.toBeNull();
    spool.close();
  });

  it('atomically leases a row across two spool processes and fences stale ACKs', () => {
    const path = join(tmpdir(), `pdos-tg-${randomUUID()}.sqlite`);
    const now = '2026-09-14T00:00:00.000Z';
    const first = new TelegramSpool(path, { random: () => 0 });
    const second = new TelegramSpool(path, { random: () => 0 });
    first.enqueue(event('00000000-0000-4000-8000-000000000024'), now);
    const firstClaim = first.claimReady(now)!;
    expect(second.claimReady(now)).toBeNull();
    const secondClaim = second.claimReady('2026-09-14T00:00:31.000Z')!;
    expect(secondClaim.leaseToken).not.toBe(firstClaim.leaseToken);
    expect(first.ack(firstClaim.id, firstClaim.leaseToken)).toBe(false);
    expect(second.claimReady('2026-09-14T00:00:31.000Z')).toBeNull();
    expect(second.ack(secondClaim.id, secondClaim.leaseToken)).toBe(true);
    first.close();
    second.close();
  });

  it('renews an active lease and rejects stale renewal tokens', () => {
    const path = join(tmpdir(), `pdos-tg-${randomUUID()}.sqlite`);
    const spool = new TelegramSpool(path);
    const now = '2026-09-14T00:00:00.000Z';
    spool.enqueue(event('00000000-0000-4000-8000-000000000025'), now);
    const item = spool.claimReady(now)!;
    expect(spool.renew(item.id, item.leaseToken, '2026-09-14T00:00:20.000Z')).toBe(true);
    expect(spool.claimReady('2026-09-14T00:00:31.000Z')).toBeNull();
    expect(spool.renew(item.id, 'stale-token', '2026-09-14T00:01:00.000Z')).toBe(false);
    spool.close();
  });
});
