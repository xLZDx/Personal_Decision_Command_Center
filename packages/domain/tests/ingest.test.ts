import { describe, expect, it } from 'vitest';
import { NormalizedEventSchema, SCHEMA_VERSION, type NormalizedEvent } from '@pdos/contracts';
import {
  createTestD1,
  loadG2Schema,
  seedBaselineAccounts,
  type SeedAccountsResult,
} from '@pdos/testkit';

import { ingestEvent } from '../src/ingest.js';

function buildEvent(
  accounts: SeedAccountsResult,
  overrides: Record<string, unknown> = {},
): NormalizedEvent {
  const raw = {
    event_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    source: 'gmail',
    source_account_id: accounts.gmailAccountId,
    source_event_id: 'msg-abc123',
    source_thread_id: null,
    event_type: 'MESSAGE_CREATED',
    direction: 'INBOUND',
    occurred_at: '2026-09-13T00:00:00.000Z',
    received_at: '2026-09-13T00:00:01.000Z',
    content_locator: { kind: 'SOURCE_REF', ref: 'gmail:msg-abc123' },
    routing_hints: [],
    source_policy_id: accounts.gmailPolicyId,
    trace_id: 'trace-1',
    schema_version: SCHEMA_VERSION,
    source_version: null,
    ...overrides,
  };
  return NormalizedEventSchema.parse(raw);
}

async function setup() {
  const db = createTestD1(loadG2Schema());
  const accounts = await seedBaselineAccounts(db);
  return { db, accounts };
}

describe('ingestEvent', () => {
  it('accepts a well-formed event and creates a PENDING outbox row', async () => {
    const { db, accounts } = await setup();
    const outcome = await ingestEvent(db, buildEvent(accounts));
    expect(outcome).toEqual({ status: 'ACCEPTED', eventId: buildEvent(accounts).event_id });

    const row = await db
      .prepare('SELECT state, processing_attempt_count FROM ingest_events WHERE event_id = ?')
      .bind(buildEvent(accounts).event_id)
      .first<{ state: string; processing_attempt_count: number }>();
    expect(row).toEqual({ state: 'ACCEPTED', processing_attempt_count: 0 });

    const outbox = await db
      .prepare('SELECT state FROM processing_outbox WHERE event_id = ?')
      .bind(buildEvent(accounts).event_id)
      .first<{ state: string }>();
    expect(outbox).toEqual({ state: 'PENDING' });
  });

  it('MAJOR regression (G2 gate review): persists a non-null source_thread_id, not silently discarding it', async () => {
    const { db, accounts } = await setup();
    const event = buildEvent(accounts, { source_thread_id: 'thread-xyz-789' });
    await ingestEvent(db, event);

    const row = await db
      .prepare('SELECT source_thread_id FROM ingest_events WHERE event_id = ?')
      .bind(event.event_id)
      .first<{ source_thread_id: string | null }>();
    expect(row?.source_thread_id).toBe('thread-xyz-789');
  });

  it('is idempotent: a duplicate submission (same idempotency key) is a no-op, not an error', async () => {
    const { db, accounts } = await setup();
    const first = await ingestEvent(db, buildEvent(accounts));
    // A retried submission may carry a fresh event_id (a new UUID per delivery attempt) but the
    // SAME source-stable identity -- this must resolve back to the ORIGINAL event_id, not create
    // a second logical event.
    const second = await ingestEvent(
      db,
      buildEvent(accounts, { event_id: 'a3f8a6de-96db-4b53-9a34-6a9f6e6b6a11' }),
    );
    expect(second).toEqual({ status: 'ALREADY_ACCEPTED', eventId: first.eventId });

    const count = await db
      .prepare('SELECT COUNT(*) as n FROM ingest_events')
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('persists routing hints and their provenance edges atomically with the event', async () => {
    const { db, accounts } = await setup();
    // First seed a real prior event this hint's provenance can legitimately point at.
    await ingestEvent(
      db,
      buildEvent(accounts, { event_id: '11111111-1111-1111-1111-111111111111' }),
    );

    const event = buildEvent(accounts, {
      event_id: '22222222-2222-2222-2222-222222222222',
      source_event_id: 'msg-def456',
      content_locator: { kind: 'SOURCE_REF', ref: 'gmail:msg-def456' },
      routing_hints: [
        {
          value: 'topic:invoices',
          provenance: ['11111111-1111-1111-1111-111111111111'],
          derivation_method: 'RULE',
          ai_policy: 'ALLOW',
          sensitivity: 'general',
          created_at: '2026-09-13T00:00:00.000Z',
          derivation_version: 1,
        },
      ],
    });

    await ingestEvent(db, event);

    const hint = await db
      .prepare(
        'SELECT value, ai_policy, sensitivity FROM ingest_event_routing_hints WHERE event_id = ? AND hint_index = 0',
      )
      .bind(event.event_id)
      .first<{ value: string; ai_policy: string; sensitivity: string }>();
    expect(hint).toEqual({ value: 'topic:invoices', ai_policy: 'ALLOW', sensitivity: 'general' });

    const provenance = await db
      .prepare(
        'SELECT provenance_event_id FROM ingest_event_routing_hint_provenance WHERE event_id = ? AND hint_index = 0',
      )
      .bind(event.event_id)
      .first<{ provenance_event_id: string }>();
    expect(provenance?.provenance_event_id).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('rolls back the whole batch (no orphan hint rows) when a hint cites an unresolvable provenance id', async () => {
    const { db, accounts } = await setup();
    const event = buildEvent(accounts, {
      routing_hints: [
        {
          value: 'topic:invoices',
          provenance: ['event-that-does-not-exist'],
          derivation_method: 'RULE',
          ai_policy: 'ALLOW',
          sensitivity: 'general',
          created_at: '2026-09-13T00:00:00.000Z',
          derivation_version: 1,
        },
      ],
    });

    await expect(ingestEvent(db, event)).rejects.toThrow();

    const eventRow = await db
      .prepare('SELECT 1 as x FROM ingest_events WHERE event_id = ?')
      .bind(event.event_id)
      .first();
    expect(eventRow).toBeNull();
  });
});
