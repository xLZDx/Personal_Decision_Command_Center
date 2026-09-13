/* global Request, Headers */
import { describe, expect, it } from 'vitest';
import type { D1Database, D1PreparedStatement, D1Result, Queue } from '@cloudflare/workers-types';
import {
  createTestD1,
  loadG2Schema,
  seedBaselineAccounts,
  seedSigningKey,
  TEST_HMAC_SECRET,
} from '@pdos/testkit';
import {
  canonicalSigningPayload,
  getOldestUnprocessedEvent,
  sha256Hex,
  signHmac,
} from '@pdos/domain';
import { SCHEMA_VERSION, type QueuePayload } from '@pdos/contracts';

import { handleIngestRequest, handleScheduled } from '@pdos/ingest-service';
import type { IngestEnv } from '@pdos/ingest-service';
import processorHandler from '@pdos/processor-service';
import type { ProcessorEnv } from '@pdos/processor-service';

/**
 * TDD §35/§71: "Mandatory gate budget test simulates at least 200 events/day normal, 1000
 * events/day stress, and records actual/estimated D1 writes/event, D1 reads/event, Queue ops/event,
 * Analytics datapoints/event, HTTP requests/event." This runs the REAL pipeline end to end --
 * `handleIngestRequest` (the actual HTTP handler), `handleScheduled` (the actual cron reconciler,
 * run repeatedly with its own production default batch size until drained, exactly as Cloudflare
 * Cron Triggers would invoke it once per minute), and the real Queue consumer (`processorHandler`)
 * -- rather than calling domain functions directly, so the counts below reflect what production
 * would actually spend, not an idealized shortcut through the pipeline.
 *
 * Honesty note (evidence over inference): `D1 reads/writes` here count STATEMENT EXECUTIONS
 * (`.run()`/`.first()`/`.all()`/each statement inside a `.batch()`), classified by leading SQL
 * keyword -- not Cloudflare's actual row-based billing unit (D1 bills per row read/written, and
 * this project's own `createTestD1` test shim never populates `rows_read` for a SELECT, so that
 * finer-grained number is not obtainable from this harness). This is a per-event OPERATION-COUNT
 * estimate, not a claim about real D1 billing quantities. `Analytics datapoints/event` is reported
 * as 0 rather than estimated: G2 has no Analytics Engine binding anywhere in its own scope --
 * inventing a plausible-looking non-zero number here would be exactly the kind of unverified claim
 * project rules forbid.
 */

type OpKind = 'read' | 'write';

function classify(sql: string): OpKind {
  return sql.trimStart().toUpperCase().startsWith('SELECT') ? 'read' : 'write';
}

const REAL = Symbol('real');
const KIND = Symbol('kind');
interface CountedStatement extends D1PreparedStatement {
  [REAL]: D1PreparedStatement;
  [KIND]: OpKind;
}

function wrapStatement(
  sql: string,
  real: D1PreparedStatement,
  counts: Record<OpKind, number>,
): CountedStatement {
  const kind = classify(sql);
  return {
    [REAL]: real,
    [KIND]: kind,
    bind(...values: unknown[]): D1PreparedStatement {
      return wrapStatement(sql, real.bind(...values), counts);
    },
    async first<T>(colName?: string): Promise<T | null> {
      counts[kind]++;
      return colName === undefined ? real.first<T>() : real.first<T>(colName);
    },
    async run<T>(): Promise<D1Result<T>> {
      counts[kind]++;
      return real.run<T>();
    },
    async all<T>(): Promise<D1Result<T>> {
      counts[kind]++;
      return real.all<T>();
    },
    raw(): never {
      throw new Error('budget harness: raw() is not exercised by G2 pipeline code');
    },
  } as CountedStatement;
}

/** Wraps a real (test-shim) D1Database, counting every statement execution -- including each
 *  individual statement inside a `db.batch()` call, since Cloudflare's real D1 also charges each
 *  statement in a batch independently, not the batch as one unit. */
function wrapCountingD1(db: D1Database, counts: Record<OpKind, number>): D1Database {
  return {
    prepare(sql: string): D1PreparedStatement {
      return wrapStatement(sql, db.prepare(sql), counts);
    },
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const real = statements.map((s) => {
        const counted = s as CountedStatement;
        counts[counted[KIND]]++;
        return counted[REAL];
      });
      return db.batch<T>(real);
    },
    exec: db.exec.bind(db),
    withSession: db.withSession.bind(db),
    dump: db.dump.bind(db),
  } as D1Database;
}

const NOW = '2026-09-13T00:00:00.000Z';

function uuidFor(index: number): string {
  // Deterministic v4-shaped UUIDs (event_id must satisfy QueuePayloadSchema's z.string().uuid()).
  const hex = index.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

async function buildSignedRequest(index: number): Promise<Request> {
  const eventId = uuidFor(index);
  const bodyObject = {
    event_id: eventId,
    source: 'gmail',
    source_account_id: 'acc-gmail-test',
    source_event_id: `msg-${index}`,
    source_thread_id: null,
    event_type: 'MESSAGE_CREATED',
    direction: 'INBOUND',
    occurred_at: NOW,
    received_at: NOW,
    content_locator: { kind: 'SOURCE_REF', ref: `gmail:msg-${index}` },
    routing_hints: [],
    source_policy_id: 'pol-gmail-allow',
    trace_id: `trace-${index}`,
    schema_version: SCHEMA_VERSION,
    source_version: null,
  };
  const bodyText = JSON.stringify(bodyObject);
  const bodyHash = await sha256Hex(bodyText);
  const nonce = `nonce-${index}`;
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

interface BudgetResult {
  eventCount: number;
  d1WritesPerEvent: number;
  d1ReadsPerEvent: number;
  queueOpsPerEvent: number;
  analyticsDatapointsPerEvent: number;
  httpRequestsPerEvent: number;
  cronTicks: number;
  processedCount: number;
}

async function runBudgetSimulation(eventCount: number): Promise<BudgetResult> {
  const counts: Record<OpKind, number> = { read: 0, write: 0 };
  const rawDb = createTestD1(loadG2Schema());
  await seedBaselineAccounts(rawDb);
  await seedSigningKey(rawDb, {
    connectorId: 'gmail',
    keyVersion: 'v1',
    status: 'ACTIVE',
    validFrom: '2026-09-01T00:00:00.000Z',
    validUntil: null,
  });
  const db = wrapCountingD1(rawDb, counts);

  let queueOps = 0;
  const queuedMessages: QueuePayload[] = [];
  const send = async (message: QueuePayload): Promise<void> => {
    queueOps++;
    queuedMessages.push(message);
  };
  const env: IngestEnv = {
    DB: db,
    INGEST_QUEUE: { send } as unknown as Queue<QueuePayload>,
    GMAIL_V1_HMAC_SECRET: TEST_HMAC_SECRET,
  };

  let httpRequests = 0;
  for (let i = 0; i < eventCount; i++) {
    const request = await buildSignedRequest(i);
    const response = await handleIngestRequest(request, env, NOW);
    httpRequests++;
    if (response.status !== 202) {
      throw new Error(`budget harness: ingest ${i} unexpectedly returned ${response.status}`);
    }
  }

  // Cloudflare Cron Triggers invoke the scheduled handler once per minute, and
  // RECONCILER_BATCH_SIZE bounds each tick's own work -- drain exactly the way production would,
  // not in one artificially unbounded call.
  let cronTicks = 0;
  for (;;) {
    const result = await handleScheduled(env, NOW);
    cronTicks++;
    if (result.dispatch.dispatched.length === 0) break;
    if (cronTicks > eventCount + 10) {
      throw new Error('budget harness: reconciler did not drain within a sane tick bound');
    }
  }
  expect(queuedMessages).toHaveLength(eventCount);

  const processorEnv: ProcessorEnv = { DB: db };
  const batch = {
    messages: queuedMessages.map((body, idx) => ({
      id: `m${idx}`,
      timestamp: new Date(),
      body,
      attempts: 1,
      retry: () => undefined,
      ack: () => undefined,
    })),
    queue: 'ingest-dispatch',
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll: () => undefined,
    ackAll: () => undefined,
  };
  await processorHandler.queue!(batch as never, processorEnv);

  const processed = await rawDb
    .prepare("SELECT COUNT(*) as n FROM ingest_events WHERE state = 'PROCESSED'")
    .first<{ n: number }>();
  const processedCount = processed?.n ?? 0;

  return {
    eventCount,
    d1WritesPerEvent: counts.write / eventCount,
    d1ReadsPerEvent: counts.read / eventCount,
    queueOpsPerEvent: queueOps / eventCount,
    analyticsDatapointsPerEvent: 0,
    httpRequestsPerEvent: httpRequests / eventCount,
    cronTicks,
    processedCount,
  };
}

describe('G2 quota budget (TDD §35/§71: 200-event/day and 1000-event/day D1/Queue/request budgets)', () => {
  it.each([200, 1000])(
    'simulates %i events/day end to end and every event reaches PROCESSED',
    async (eventCount) => {
      const result = await runBudgetSimulation(eventCount);

      expect(result.processedCount).toBe(eventCount);
      // Exactly 1 inbound HTTP request per event -- no retries, no polling, on the happy path this
      // harness exercises (the failure/redispatch paths are covered by packages/domain's own
      // reconciler/lease test suites, not duplicated here).
      expect(result.httpRequestsPerEvent).toBe(1);
      // Exactly 1 Queue send per event under normal (non-redispatch) operation.
      expect(result.queueOpsPerEvent).toBe(1);
      expect(result.analyticsDatapointsPerEvent).toBe(0);
      // Sanity bounds, not tight assertions: a regression that multiplied D1 traffic per event
      // (e.g. an N+1 query newly introduced somewhere in the pipeline) should fail this long
      // before hitting Cloudflare's real Free-tier daily ceilings (TDD §35's own D1 quota table).
      expect(result.d1WritesPerEvent).toBeGreaterThan(0);
      expect(result.d1WritesPerEvent).toBeLessThan(20);
      expect(result.d1ReadsPerEvent).toBeGreaterThanOrEqual(0);
      expect(result.d1ReadsPerEvent).toBeLessThan(20);
    },
  );

  it('the oldest accepted-unprocessed metric reflects a genuinely stuck event once the pipeline stalls mid-run (TDD §71: "oldest accepted-unprocessed metric exists")', async () => {
    const rawDb = createTestD1(loadG2Schema());
    await seedBaselineAccounts(rawDb);
    await seedSigningKey(rawDb, {
      connectorId: 'gmail',
      keyVersion: 'v1',
      status: 'ACTIVE',
      validFrom: '2026-09-01T00:00:00.000Z',
      validUntil: null,
    });
    const send = async (): Promise<void> => undefined;
    const env: IngestEnv = {
      DB: rawDb,
      INGEST_QUEUE: { send } as unknown as Queue<QueuePayload>,
      GMAIL_V1_HMAC_SECRET: TEST_HMAC_SECRET,
    };

    // Accept 3 events but never run the scheduled handler at all -- simulating a stalled
    // reconciler/Queue outage. All 3 stay accepted-unprocessed indefinitely.
    for (let i = 0; i < 3; i++) {
      const request = await buildSignedRequest(i);
      await handleIngestRequest(request, env, NOW);
    }

    const muchLater = new Date(Date.parse(NOW) + 6 * 60 * 60 * 1000).toISOString();
    const oldest = await getOldestUnprocessedEvent(rawDb, { now: muchLater });
    expect(oldest?.eventId).toBe(uuidFor(0));
    expect(oldest?.ageMs).toBe(6 * 60 * 60 * 1000);
  });
});
