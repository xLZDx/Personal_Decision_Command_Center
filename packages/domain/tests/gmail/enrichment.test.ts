import { describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import {
  createTestD1,
  loadG3Schema,
  seedBaselineAccounts,
  seedEvent,
  FIXTURE_NOW,
} from '@pdos/testkit';

import { persistEnrichment, getEnrichment } from '../../src/gmail/enrichment.js';

async function setup() {
  const db = createTestD1(loadG3Schema());
  const accounts = await seedBaselineAccounts(db);
  return { db, accounts };
}

describe('persistEnrichment', () => {
  it('PERSISTED: a valid active lease can author the enrichment', async () => {
    const { db, accounts } = await setup();
    await seedEvent(db, accounts, {
      eventId: 'ev-1',
      state: 'PROCESSING',
      leaseOwner: 'worker-1',
      leaseToken: 'token-A',
      leaseExpiresAt: '2026-09-13T00:02:00.000Z',
    });

    const result = await persistEnrichment(db, {
      eventId: 'ev-1',
      leaseToken: 'token-A',
      now: FIXTURE_NOW,
      input: {
        status: 'COMPLETE',
        summary: 'A short summary',
        extractedJson: '{"kind":"invoice"}',
        modelId: 'test-model-v1',
      },
    });
    expect(result).toEqual({ outcome: 'PERSISTED' });

    const row = await getEnrichment(db, 'ev-1');
    expect(row).toEqual({
      eventId: 'ev-1',
      status: 'COMPLETE',
      summary: 'A short summary',
      extractedJson: '{"kind":"invoice"}',
      modelId: 'test-model-v1',
    });
  });

  it(
    'LEASE_LOST: the exact GPT-PM round-3 BLOCKER ABA scenario -- attempt A holds a stale token ' +
      'after attempt B has legitimately reclaimed the lease; A must not be able to author the ' +
      'canonical enrichment',
    async () => {
      const { db, accounts } = await setup();
      await seedEvent(db, accounts, {
        eventId: 'ev-2',
        state: 'PROCESSING',
        leaseOwner: 'worker-B',
        leaseToken: 'token-B', // B already won the reclaim by the time A's write lands
        leaseExpiresAt: '2026-09-13T00:05:00.000Z',
      });

      const staleWrite = await persistEnrichment(db, {
        eventId: 'ev-2',
        leaseToken: 'token-A', // A's own, now-superseded token
        now: FIXTURE_NOW,
        input: {
          status: 'COMPLETE',
          summary: 'stale',
          extractedJson: '{}',
          modelId: 'test-model-v1',
        },
      });
      expect(staleWrite).toEqual({ outcome: 'LEASE_LOST' });

      const row = await getEnrichment(db, 'ev-2');
      expect(row).toBeNull();

      // B, the actual current holder, can still author the canonical result afterward.
      const winningWrite = await persistEnrichment(db, {
        eventId: 'ev-2',
        leaseToken: 'token-B',
        now: FIXTURE_NOW,
        input: {
          status: 'COMPLETE',
          summary: 'canonical',
          extractedJson: '{}',
          modelId: 'test-model-v1',
        },
      });
      expect(winningWrite).toEqual({ outcome: 'PERSISTED' });
      expect((await getEnrichment(db, 'ev-2'))?.summary).toBe('canonical');
    },
  );

  it('LEASE_LOST: the event is not even PROCESSING (already completed elsewhere)', async () => {
    const { db, accounts } = await setup();
    await seedEvent(db, accounts, { eventId: 'ev-3', state: 'PROCESSED' });

    const result = await persistEnrichment(db, {
      eventId: 'ev-3',
      leaseToken: 'token-anything',
      now: FIXTURE_NOW,
      input: { status: 'NO_CONTENT_DELETED' },
    });
    expect(result).toEqual({ outcome: 'LEASE_LOST' });
    expect(await getEnrichment(db, 'ev-3')).toBeNull();
  });

  it(
    "functional-test review follow-up: the fence's own `state = 'PROCESSING' AND` clause cannot " +
      "be isolated by a 'matching token, wrong state' fixture, because ingest_events' OWN schema " +
      '(migration 0001) makes that combination structurally impossible to store -- ' +
      "'(state = PROCESSING) = (lease_expires_at IS NOT NULL)' and " +
      "'(lease_token IS NULL) = (lease_expires_at IS NULL)' together force a non-PROCESSING row's " +
      'lease_token to always be NULL, so a real (non-null) token can never coincide with a ' +
      'non-PROCESSING state. This test proves that structural guarantee directly (attempting the ' +
      'exact fixture a token-only-vs-token+state test would need throws a CHECK violation at seed ' +
      'time), which is why the LEASE_LOST tests above -- both of which use only token mismatches -- ' +
      "are the actual reachable coverage for this fence; state = 'PROCESSING' remains in the SQL " +
      'for explicitness and parity with every other G2 fence in transitions.ts, not because a test ' +
      'can observe it doing independent work.',
    async () => {
      const { db, accounts } = await setup();
      await expect(
        seedEvent(db, accounts, {
          eventId: 'ev-impossible',
          state: 'PROCESSED', // non-PROCESSING, so lease_expires_at stays NULL (unset below)...
          leaseToken: 'token-should-be-impossible', // ...yet a non-null token: schema must reject
        }),
      ).rejects.toThrow(/CHECK constraint failed/i);
    },
  );

  it('ALREADY_PERSISTED: a second write under a still-valid lease does not overwrite the canonical row', async () => {
    const { db, accounts } = await setup();
    await seedEvent(db, accounts, {
      eventId: 'ev-4',
      state: 'PROCESSING',
      leaseOwner: 'worker-1',
      leaseToken: 'token-A',
      leaseExpiresAt: '2026-09-13T00:02:00.000Z',
    });

    const first = await persistEnrichment(db, {
      eventId: 'ev-4',
      leaseToken: 'token-A',
      now: FIXTURE_NOW,
      input: {
        status: 'COMPLETE',
        summary: 'first',
        extractedJson: '{}',
        modelId: 'test-model-v1',
      },
    });
    expect(first).toEqual({ outcome: 'PERSISTED' });

    const second = await persistEnrichment(db, {
      eventId: 'ev-4',
      leaseToken: 'token-A',
      now: FIXTURE_NOW,
      input: {
        status: 'COMPLETE',
        summary: 'second, should never land',
        extractedJson: '{}',
        modelId: 'test-model-v1',
      },
    });
    expect(second).toEqual({ outcome: 'ALREADY_PERSISTED' });
    expect((await getEnrichment(db, 'ev-4'))?.summary).toBe('first');
  });

  it('two concurrent PERSISTED attempts under the same valid token: exactly one wins, no double row', async () => {
    const { db, accounts } = await setup();
    await seedEvent(db, accounts, {
      eventId: 'ev-concurrent',
      state: 'PROCESSING',
      leaseOwner: 'worker-1',
      leaseToken: 'token-A',
      leaseExpiresAt: '2026-09-13T00:02:00.000Z',
    });

    const attempt = (summary: string) =>
      persistEnrichment(db, {
        eventId: 'ev-concurrent',
        leaseToken: 'token-A',
        now: FIXTURE_NOW,
        input: { status: 'COMPLETE', summary, extractedJson: '{}', modelId: 'test-model-v1' },
      });

    const [a, b] = await Promise.all([attempt('race-a'), attempt('race-b')]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['ALREADY_PERSISTED', 'PERSISTED']);
  });

  it(
    'functional-test review follow-up: a non-UNIQUE-constraint error is NOT swallowed as ' +
      'ALREADY_PERSISTED -- proves the catch is scoped to isUniqueConstraintError specifically, ' +
      'not a blanket catch that would silently mask a genuine defect',
    async () => {
      const genuineFailure = new Error('D1_ERROR: some other failure, not a UNIQUE constraint');
      const throwingDb = {
        prepare: () => ({
          bind: () => ({
            run: async () => {
              throw genuineFailure;
            },
          }),
        }),
      } as unknown as D1Database;

      await expect(
        persistEnrichment(throwingDb, {
          eventId: 'ev-doesnt-matter',
          leaseToken: 'token-doesnt-matter',
          now: FIXTURE_NOW,
          input: { status: 'NO_CONTENT_DELETED' },
        }),
      ).rejects.toThrow(genuineFailure);
    },
  );

  it(
    'MINOR fix (functional-test review): the DB-level CHECK constraint is a real backstop even ' +
      'when bypassing the typed persistEnrichment() entry point entirely -- a raw INSERT with a ' +
      'mismatched status/content combination is rejected by the schema itself, not just by ' +
      "TypeScript's discriminated union (which only guards the ONE current writer)",
    async () => {
      const { db, accounts } = await setup();
      await seedEvent(db, accounts, {
        eventId: 'ev-raw',
        state: 'PROCESSING',
        leaseOwner: 'worker-1',
        leaseToken: 'token-A',
        leaseExpiresAt: '2026-09-13T00:02:00.000Z',
      });

      // status='COMPLETE' but only ONE of the three content fields populated -- exactly the
      // combination the OLD bare-equivalence CHECK would have silently accepted.
      await expect(
        db
          .prepare(
            `INSERT INTO gmail_source_enrichments (event_id, status, summary, extracted_json, model_id, created_at)
             VALUES (?, 'COMPLETE', ?, NULL, NULL, ?)`,
          )
          .bind('ev-raw', 'a summary with no extracted_json or model_id', FIXTURE_NOW)
          .run(),
      ).rejects.toThrow(/CHECK constraint failed/i);
    },
  );

  it('NO_CONTENT_DELETED persists with all-null content fields, satisfying the schema CHECK', async () => {
    const { db, accounts } = await setup();
    await seedEvent(db, accounts, {
      eventId: 'ev-5',
      eventType: 'MESSAGE_DELETED',
      state: 'PROCESSING',
      leaseOwner: 'worker-1',
      leaseToken: 'token-A',
      leaseExpiresAt: '2026-09-13T00:02:00.000Z',
    });

    const result = await persistEnrichment(db, {
      eventId: 'ev-5',
      leaseToken: 'token-A',
      now: FIXTURE_NOW,
      input: { status: 'NO_CONTENT_DELETED' },
    });
    expect(result).toEqual({ outcome: 'PERSISTED' });

    const row = await getEnrichment(db, 'ev-5');
    expect(row).toEqual({
      eventId: 'ev-5',
      status: 'NO_CONTENT_DELETED',
      summary: null,
      extractedJson: null,
      modelId: null,
    });
  });
});

describe('getEnrichment', () => {
  it('returns null when no row exists', async () => {
    const { db } = await setup();
    expect(await getEnrichment(db, 'never-existed')).toBeNull();
  });
});
