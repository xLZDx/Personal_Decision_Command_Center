import { describe, expect, it } from 'vitest';
import {
  createTestD1,
  loadG3Schema,
  seedBaselineAccounts,
  seedGmailConnection,
  seedSourceCursor,
  FIXTURE_NOW,
} from '@pdos/testkit';
import { NormalizedEventSchema, idempotencyKey, type NormalizedEvent } from '@pdos/contracts';

import {
  syncGmailAccountHistory,
  GmailHistoryCursorInvalidError,
  GmailHistoryCursorMissingBootstrapError,
} from '../../src/gmail/history-sync.js';
import type {
  GmailHistoryClient,
  GmailHistoryPage,
  GmailListMessagesInWindowResult,
  GmailMessageMetadata,
  GmailEventSubmitter,
} from '../../src/gmail/history-sync.js';

async function setup(
  opts: {
    watchHistoryId?: string | null;
    cursorValue?: string | null;
    skipConnection?: boolean;
  } = {},
) {
  const db = createTestD1(loadG3Schema());
  const accounts = await seedBaselineAccounts(db);
  if (!opts.skipConnection) {
    await seedGmailConnection(db, {
      sourceAccountId: accounts.gmailAccountId,
      watchHistoryId: opts.watchHistoryId === undefined ? 'watch-100' : opts.watchHistoryId,
      connectedAt: FIXTURE_NOW,
    });
  }
  if (opts.cursorValue !== undefined) {
    await seedSourceCursor(db, {
      sourceAccountId: accounts.gmailAccountId,
      cursorValue: opts.cursorValue,
    });
  }
  return { db, accounts };
}

async function readCursorRow(db: Awaited<ReturnType<typeof setup>>['db'], sourceAccountId: string) {
  return db
    .prepare('SELECT cursor_value FROM source_cursors WHERE source_account_id = ?')
    .bind(sourceAccountId)
    .first<{ cursor_value: string | null } | null>();
}

interface FakeHistoryClientConfig {
  historyPages?: GmailHistoryPage[];
  metadataByMessageId?: Record<string, GmailMessageMetadata>;
  throwInvalidCursorOnCall?: number;
  /** A generic (non-`GmailHistoryCursorInvalidError`) failure -- simulates a plain crash/network
   *  loss fetching the Nth page, distinct from Gmail reporting an invalid cursor. */
  throwGenericErrorOnCall?: number;
  windowPages?: GmailListMessagesInWindowResult[];
  currentHistoryId?: string;
}

function fakeHistoryClient(config: FakeHistoryClientConfig) {
  let historyCallIndex = 0;
  let windowCallIndex = 0;
  const calls = {
    listHistory: 0,
    getMessageMetadata: [] as string[],
    listMessagesInWindow: 0,
    getCurrentHistoryId: 0,
  };
  const client: GmailHistoryClient = {
    async listHistory() {
      calls.listHistory += 1;
      historyCallIndex += 1;
      if (config.throwGenericErrorOnCall === historyCallIndex) {
        throw new Error('simulated crash before this page could be fetched');
      }
      if (config.throwInvalidCursorOnCall === historyCallIndex) {
        throw new GmailHistoryCursorInvalidError('bad-cursor');
      }
      const page = config.historyPages?.[historyCallIndex - 1];
      if (!page)
        throw new Error(`fakeHistoryClient: no scripted page for call ${historyCallIndex}`);
      return page;
    },
    async getMessageMetadata(opts) {
      calls.getMessageMetadata.push(opts.messageId);
      const metadata = config.metadataByMessageId?.[opts.messageId];
      if (!metadata) throw new Error(`fakeHistoryClient: no metadata for ${opts.messageId}`);
      return metadata;
    },
    async listMessagesInWindow() {
      calls.listMessagesInWindow += 1;
      windowCallIndex += 1;
      const page = config.windowPages?.[windowCallIndex - 1];
      if (!page) {
        throw new Error(`fakeHistoryClient: no scripted window page for call ${windowCallIndex}`);
      }
      return page;
    },
    async getCurrentHistoryId() {
      calls.getCurrentHistoryId += 1;
      return config.currentHistoryId ?? 'recovery-history-id';
    },
  };
  return { client, calls };
}

function fakeSubmitter() {
  const submitted: NormalizedEvent[] = [];
  const seenKeys = new Map<string, string>();
  let throwAfter: number | null = null;
  let callCount = 0;
  const submitter: GmailEventSubmitter = {
    async submit(event) {
      callCount += 1;
      if (throwAfter !== null && callCount > throwAfter) {
        throw new Error('simulated crash mid-traversal');
      }
      submitted.push(event);
      const key = idempotencyKey(event);
      const existing = seenKeys.get(key);
      if (existing !== undefined) return { status: 'ALREADY_ACCEPTED', eventId: existing };
      seenKeys.set(key, event.event_id);
      return { status: 'ACCEPTED', eventId: event.event_id };
    },
  };
  return {
    submitter,
    submitted,
    setThrowAfter: (n: number | null) => {
      throwAfter = n;
      callCount = 0;
    },
  };
}

describe('syncGmailAccountHistory -- §2.3 normalization matrix', () => {
  it('messagesAdded -> MESSAGE_CREATED, no source_version, occurred_at/direction from messages.get', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'h1', lastSeenInternalDate: FIXTURE_NOW }),
    });
    const { client } = fakeHistoryClient({
      historyPages: [
        {
          historyId: 'h2',
          records: [
            {
              historyRecordId: 'r1',
              messagesAdded: [{ messageId: 'm1', threadId: 't1' }],
              messagesDeleted: [],
              labelsAdded: [],
              labelsRemoved: [],
            },
          ],
        },
      ],
      metadataByMessageId: {
        m1: { internalDate: '2026-09-13T01:00:00.000Z', labelIds: ['INBOX'] },
      },
    });
    const { submitter, submitted } = fakeSubmitter();

    const result = await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(result.outcome).toBe('SYNCED');
    expect(submitted).toHaveLength(1);
    const event = NormalizedEventSchema.parse(submitted[0]);
    expect(event.event_type).toBe('MESSAGE_CREATED');
    expect(event.source_event_id).toBe('m1');
    expect(event.source_thread_id).toBe('t1');
    expect(event.source_version).toBeNull();
    expect(event.occurred_at).toBe('2026-09-13T01:00:00.000Z');
    // GPT-PM round-2 MAJOR (contract fix, ruling option (b)): a real provider timestamp
    // (messages.get's internalDate) is genuinely PROVIDER_REPORTED, not an estimate.
    expect(event.occurred_at_quality).toBe('PROVIDER_REPORTED');
    expect(event.direction).toBe('INBOUND');
    expect(event.content_locator).toEqual({ kind: 'SOURCE_REF', ref: 'm1' });
  });

  it('a SENT label on the created message -> OUTBOUND', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'h1', lastSeenInternalDate: FIXTURE_NOW }),
    });
    const { client } = fakeHistoryClient({
      historyPages: [
        {
          historyId: 'h2',
          records: [
            {
              historyRecordId: 'r1',
              messagesAdded: [{ messageId: 'm1', threadId: 't1' }],
              messagesDeleted: [],
              labelsAdded: [],
              labelsRemoved: [],
            },
          ],
        },
      ],
      metadataByMessageId: {
        m1: { internalDate: '2026-09-13T01:00:00.000Z', labelIds: ['SENT'] },
      },
    });
    const { submitter, submitted } = fakeSubmitter();

    await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(submitted[0]?.direction).toBe('OUTBOUND');
  });

  it('messagesDeleted -> MESSAGE_DELETED, no source_version, occurred_at is processing time', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'h1', lastSeenInternalDate: FIXTURE_NOW }),
    });
    const { client } = fakeHistoryClient({
      historyPages: [
        {
          historyId: 'h2',
          records: [
            {
              historyRecordId: 'r1',
              messagesAdded: [],
              messagesDeleted: [{ messageId: 'm1', threadId: 't1' }],
              labelsAdded: [],
              labelsRemoved: [],
            },
          ],
        },
      ],
    });
    const { submitter, submitted } = fakeSubmitter();
    const now = '2026-09-13T02:00:00.000Z';

    await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now,
    });

    const event = NormalizedEventSchema.parse(submitted[0]);
    expect(event.event_type).toBe('MESSAGE_DELETED');
    expect(event.source_version).toBeNull();
    expect(event.occurred_at).toBe(now);
    // GPT-PM round-2 MAJOR (contract fix, ruling option (b)): Gmail exposes no per-signal
    // timestamp for a deletion, so occurred_at here is an ESTIMATE (processing time), not
    // genuine provider provenance -- the contract must say so explicitly, not just via a
    // matching-but-unmarked occurred_at === received_at value.
    expect(event.occurred_at_quality).toBe('ESTIMATED_FROM_RECEIPT');
  });

  it('labelsAdded -> MESSAGE_UPDATED with {historyRecordId}:LABEL_ADDED source_version', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'h1', lastSeenInternalDate: FIXTURE_NOW }),
    });
    const { client } = fakeHistoryClient({
      historyPages: [
        {
          historyId: 'h2',
          records: [
            {
              historyRecordId: 'r7',
              messagesAdded: [],
              messagesDeleted: [],
              labelsAdded: [{ messageId: 'm1', threadId: 't1' }],
              labelsRemoved: [],
            },
          ],
        },
      ],
    });
    const { submitter, submitted } = fakeSubmitter();

    await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    const event = NormalizedEventSchema.parse(submitted[0]);
    expect(event.event_type).toBe('MESSAGE_UPDATED');
    expect(event.source_version).toBe('r7:LABEL_ADDED');
    expect(event.occurred_at_quality).toBe('ESTIMATED_FROM_RECEIPT');
  });

  it('labelsAdded and labelsRemoved for the SAME message in the SAME record -> two MESSAGE_UPDATED events with distinct source_version', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'h1', lastSeenInternalDate: FIXTURE_NOW }),
    });
    const { client } = fakeHistoryClient({
      historyPages: [
        {
          historyId: 'h2',
          records: [
            {
              historyRecordId: 'r9',
              messagesAdded: [],
              messagesDeleted: [],
              labelsAdded: [{ messageId: 'm1', threadId: 't1' }],
              labelsRemoved: [{ messageId: 'm1', threadId: 't1' }],
            },
          ],
        },
      ],
    });
    const { submitter, submitted } = fakeSubmitter();

    await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(submitted).toHaveLength(2);
    // event_type is asserted for BOTH members, not just source_version -- a mutation that
    // misclassifies either event's event_type (while leaving source_version untouched) would
    // otherwise pass NormalizedEventSchema.parse() (MESSAGE_UPDATED-only is the only event_type
    // constraint tied to source_version) and go undetected by a source_version-only assertion.
    for (const event of submitted) {
      expect(event.event_type).toBe('MESSAGE_UPDATED');
      expect(event.occurred_at_quality).toBe('ESTIMATED_FROM_RECEIPT');
    }
    const versions = submitted.map((e) => e.source_version).sort();
    expect(versions).toEqual(['r9:LABEL_ADDED', 'r9:LABEL_REMOVED']);
    const keys = new Set(submitted.map((e) => idempotencyKey(e)));
    expect(keys.size).toBe(2); // distinct idempotency keys -- neither silently drops the other
  });

  it("the SAME messageId appearing twice within one record's own labelsAdded array collapses into ONE MESSAGE_UPDATED event", async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'h1', lastSeenInternalDate: FIXTURE_NOW }),
    });
    const { client } = fakeHistoryClient({
      historyPages: [
        {
          historyId: 'h2',
          records: [
            {
              historyRecordId: 'r5',
              messagesAdded: [],
              messagesDeleted: [],
              labelsAdded: [
                { messageId: 'm1', threadId: 't1' },
                { messageId: 'm1', threadId: 't1' },
              ],
              labelsRemoved: [],
            },
          ],
        },
      ],
    });
    const { submitter, submitted } = fakeSubmitter();

    const result = await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(submitted).toHaveLength(1);
    expect(result.outcome).toBe('SYNCED');
    if (result.outcome === 'SYNCED') {
      expect(result.counts).toEqual({ accepted: 1, alreadyAccepted: 0 });
    }
  });

  it('messagesAdded + labelsAdded for the same message in one record -> two events, different event_type', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'h1', lastSeenInternalDate: FIXTURE_NOW }),
    });
    const { client } = fakeHistoryClient({
      historyPages: [
        {
          historyId: 'h2',
          records: [
            {
              historyRecordId: 'r3',
              messagesAdded: [{ messageId: 'm1', threadId: 't1' }],
              messagesDeleted: [],
              labelsAdded: [{ messageId: 'm1', threadId: 't1' }],
              labelsRemoved: [],
            },
          ],
        },
      ],
      metadataByMessageId: {
        m1: { internalDate: '2026-09-13T01:00:00.000Z', labelIds: [] },
      },
    });
    const { submitter, submitted } = fakeSubmitter();

    await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(submitted).toHaveLength(2);
    const types = submitted.map((e) => e.event_type).sort();
    expect(types).toEqual(['MESSAGE_CREATED', 'MESSAGE_UPDATED']);
  });

  it('messagesAdded + messagesDeleted for the same message in one record -> two events, different event_type, neither merged', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'h1', lastSeenInternalDate: FIXTURE_NOW }),
    });
    const { client } = fakeHistoryClient({
      historyPages: [
        {
          historyId: 'h2',
          records: [
            {
              historyRecordId: 'r4',
              messagesAdded: [{ messageId: 'm1', threadId: 't1' }],
              messagesDeleted: [{ messageId: 'm1', threadId: 't1' }],
              labelsAdded: [],
              labelsRemoved: [],
            },
          ],
        },
      ],
      metadataByMessageId: {
        m1: { internalDate: '2026-09-13T01:00:00.000Z', labelIds: [] },
      },
    });
    const { submitter, submitted } = fakeSubmitter();

    await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(submitted).toHaveLength(2);
    const types = submitted.map((e) => e.event_type).sort();
    expect(types).toEqual(['MESSAGE_CREATED', 'MESSAGE_DELETED']);
    const keys = new Set(submitted.map((e) => idempotencyKey(e)));
    expect(keys.size).toBe(2); // distinct idempotency keys -- CREATED and DELETED never collide
  });

  it('same input submitted twice (repeated delivery) -> identical idempotency_key -> one logical row', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'h1', lastSeenInternalDate: FIXTURE_NOW }),
    });
    const record = {
      historyRecordId: 'r1',
      messagesAdded: [{ messageId: 'm1', threadId: 't1' }],
      messagesDeleted: [],
      labelsAdded: [],
      labelsRemoved: [],
    };
    const { client } = fakeHistoryClient({
      historyPages: [{ historyId: 'h2', records: [record, record] }],
      metadataByMessageId: {
        m1: { internalDate: '2026-09-13T01:00:00.000Z', labelIds: [] },
      },
    });
    const { submitter, submitted } = fakeSubmitter();

    const result = await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    // classifyHistoryRecord dedupes WITHIN one record already, but this proves the case where the
    // SAME message.id appears again (e.g. as a distinct record in the page) still collapses via
    // central idempotency, not via app-level dedup: both attempts are actually submitted (the
    // module does not try to detect this itself), but the second resolves to ALREADY_ACCEPTED on
    // the SAME idempotency_key, not a second logical row.
    expect(submitted).toHaveLength(2);
    expect(idempotencyKey(submitted[0]!)).toBe(idempotencyKey(submitted[1]!));
    expect(result.outcome).toBe('SYNCED');
    if (result.outcome === 'SYNCED') {
      expect(result.counts).toEqual({ accepted: 1, alreadyAccepted: 1 });
    }
  });
});

describe('syncGmailAccountHistory -- §2.2 crash-safe accept-then-advance cursor protocol', () => {
  it('cursor is not touched anywhere in the loop; only CAS-advances on the final page (no nextPageToken)', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'h1', lastSeenInternalDate: FIXTURE_NOW }),
    });
    const { client } = fakeHistoryClient({
      historyPages: [
        {
          historyId: 'IGNORED-intermediate-historyId',
          nextPageToken: 'page2',
          records: [
            {
              historyRecordId: 'r1',
              messagesAdded: [{ messageId: 'm1', threadId: 't1' }],
              messagesDeleted: [],
              labelsAdded: [],
              labelsRemoved: [],
            },
          ],
        },
        {
          historyId: 'h-final',
          records: [
            {
              historyRecordId: 'r2',
              messagesAdded: [{ messageId: 'm2', threadId: 't2' }],
              messagesDeleted: [],
              labelsAdded: [],
              labelsRemoved: [],
            },
          ],
        },
      ],
      metadataByMessageId: {
        m1: { internalDate: '2026-09-13T01:00:00.000Z', labelIds: [] },
        m2: { internalDate: '2026-09-13T01:30:00.000Z', labelIds: [] },
      },
    });
    const { submitter, submitted } = fakeSubmitter();

    const result = await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(result.outcome).toBe('SYNCED');
    expect(submitted).toHaveLength(2);
    const row = await readCursorRow(db, accounts.gmailAccountId);
    const cursor = JSON.parse(row!.cursor_value as string) as {
      historyId: string;
      lastSeenInternalDate: string;
    };
    expect(cursor.historyId).toBe('h-final'); // never the intermediate page's historyId
    expect(cursor.lastSeenInternalDate).toBe('2026-09-13T01:30:00.000Z'); // max across the traversal
  });

  it('a crash before the final CAS leaves cursor A untouched; the retry re-runs the whole traversal and already-accepted events become safe no-ops', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'h1', lastSeenInternalDate: FIXTURE_NOW }),
    });
    const record1 = {
      historyRecordId: 'r1',
      messagesAdded: [{ messageId: 'm1', threadId: 't1' }],
      messagesDeleted: [],
      labelsAdded: [],
      labelsRemoved: [],
    };
    const record2 = {
      historyRecordId: 'r2',
      messagesAdded: [{ messageId: 'm2', threadId: 't2' }],
      messagesDeleted: [],
      labelsAdded: [],
      labelsRemoved: [],
    };
    const metadataByMessageId = {
      m1: { internalDate: '2026-09-13T01:00:00.000Z', labelIds: [] },
      m2: { internalDate: '2026-09-13T01:30:00.000Z', labelIds: [] },
    };
    const { submitter, submitted, setThrowAfter } = fakeSubmitter();

    // Attempt 1: crash after the first successful submission (simulating a process death mid-page).
    setThrowAfter(1);
    const attempt1Client = fakeHistoryClient({
      historyPages: [{ historyId: 'h-final', records: [record1, record2] }],
      metadataByMessageId,
    });
    await expect(
      syncGmailAccountHistory(db, attempt1Client.client, submitter, {
        sourceAccountId: accounts.gmailAccountId,
        sourcePolicyId: accounts.gmailPolicyId,
        connectedAt: FIXTURE_NOW,
        now: '2026-09-13T02:00:00.000Z',
      }),
    ).rejects.toThrow('simulated crash mid-traversal');

    const rowAfterCrash = await readCursorRow(db, accounts.gmailAccountId);
    expect(JSON.parse(rowAfterCrash!.cursor_value as string)).toEqual({
      historyId: 'h1',
      lastSeenInternalDate: FIXTURE_NOW,
    });
    expect(submitted).toHaveLength(1); // only m1 got through before the simulated crash

    // Attempt 2 (the retry): cursor A is unchanged, so Gmail would hand back the SAME page again.
    setThrowAfter(null);
    const attempt2Client = fakeHistoryClient({
      historyPages: [{ historyId: 'h-final', records: [record1, record2] }],
      metadataByMessageId,
    });
    const result = await syncGmailAccountHistory(db, attempt2Client.client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:05:00.000Z',
    });

    expect(result.outcome).toBe('SYNCED');
    if (result.outcome === 'SYNCED') {
      expect(result.counts.alreadyAccepted).toBe(1); // m1's resubmission is a safe no-op
      expect(result.counts.accepted).toBe(1); // m2 goes through for real this time
    }
    const rowAfterRetry = await readCursorRow(db, accounts.gmailAccountId);
    expect(JSON.parse(rowAfterRetry!.cursor_value as string)).toMatchObject({
      historyId: 'h-final',
    });
  });

  it("a crash BETWEEN pages (page 1 fully accepted, page 2 never fetched) leaves cursor A untouched; the retry re-fetches from A, no-ops page 1, and advances only to page 2's historyId -- the literal proposal-named multi-page regression case", async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'h1', lastSeenInternalDate: FIXTURE_NOW }),
    });
    const page1 = {
      historyId: 'IGNORED-intermediate-historyId', // must never be persisted anywhere
      nextPageToken: 'page2',
      records: [
        {
          historyRecordId: 'r1',
          messagesAdded: [{ messageId: 'm1', threadId: 't1' }],
          messagesDeleted: [],
          labelsAdded: [],
          labelsRemoved: [],
        },
      ],
    };
    const page2 = {
      historyId: 'h-final',
      records: [
        {
          historyRecordId: 'r2',
          messagesAdded: [{ messageId: 'm2', threadId: 't2' }],
          messagesDeleted: [],
          labelsAdded: [],
          labelsRemoved: [],
        },
      ],
    };
    const metadataByMessageId = {
      m1: { internalDate: '2026-09-13T01:00:00.000Z', labelIds: [] },
      m2: { internalDate: '2026-09-13T01:30:00.000Z', labelIds: [] },
    };

    // Attempt 1: page 1 is fetched and fully accepted (its one event submitted for real), then
    // the SECOND listHistory call (fetching page 2) itself fails -- simulating a crash strictly
    // between page 1 completing and page 2 ever being requested, the exact condition the
    // proposal's own round-2 BLOCKER occurred under.
    const { submitter, submitted } = fakeSubmitter();
    const attempt1Client = fakeHistoryClient({
      historyPages: [page1, page2],
      metadataByMessageId,
      throwGenericErrorOnCall: 2,
    });
    await expect(
      syncGmailAccountHistory(db, attempt1Client.client, submitter, {
        sourceAccountId: accounts.gmailAccountId,
        sourcePolicyId: accounts.gmailPolicyId,
        connectedAt: FIXTURE_NOW,
        now: '2026-09-13T02:00:00.000Z',
      }),
    ).rejects.toThrow('simulated crash before this page could be fetched');

    expect(attempt1Client.calls.listHistory).toBe(2); // page 2 WAS attempted, just failed
    expect(submitted).toHaveLength(1); // only page 1's event got through
    const rowAfterCrash = await readCursorRow(db, accounts.gmailAccountId);
    expect(JSON.parse(rowAfterCrash!.cursor_value as string)).toEqual({
      historyId: 'h1', // unchanged -- NOT page1's own (ignored) historyId
      lastSeenInternalDate: FIXTURE_NOW,
    });

    // Attempt 2 (the retry): cursor A is unchanged, so Gmail hands back page 1 again from
    // scratch -- its event resolves ALREADY_ACCEPTED, page 2 (now reachable) submits for real,
    // and the cursor advances only to page 2's historyId, never the discarded intermediate one.
    const attempt2Client = fakeHistoryClient({ historyPages: [page1, page2], metadataByMessageId });
    const result = await syncGmailAccountHistory(db, attempt2Client.client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:05:00.000Z',
    });

    expect(result.outcome).toBe('SYNCED');
    if (result.outcome === 'SYNCED') {
      expect(result.counts).toEqual({ accepted: 1, alreadyAccepted: 1 });
    }
    const rowAfterRetry = await readCursorRow(db, accounts.gmailAccountId);
    expect(JSON.parse(rowAfterRetry!.cursor_value as string)).toEqual({
      historyId: 'h-final',
      lastSeenInternalDate: '2026-09-13T01:30:00.000Z',
    });
  });

  it('a concurrent writer that advances the cursor DURING this traversal causes CAS_LOST_RETRY, not a silent overwrite', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'h1', lastSeenInternalDate: FIXTURE_NOW }),
    });
    // The race happens in the window between this call's own cursor READ (already done by the
    // time syncGmailAccountHistory calls listHistory) and its final CAS WRITE -- simulated here by
    // having the concurrent write happen from inside the listHistory call itself, exactly the gap
    // a real overlapping push+poll traversal would land in.
    const client: GmailHistoryClient = {
      async listHistory() {
        await db
          .prepare('UPDATE source_cursors SET cursor_value = ? WHERE source_account_id = ?')
          .bind(
            JSON.stringify({ historyId: 'h-concurrent', lastSeenInternalDate: FIXTURE_NOW }),
            accounts.gmailAccountId,
          )
          .run();
        return {
          historyId: 'h-final',
          records: [
            {
              historyRecordId: 'r1',
              messagesAdded: [{ messageId: 'm1', threadId: 't1' }],
              messagesDeleted: [],
              labelsAdded: [],
              labelsRemoved: [],
            },
          ],
        };
      },
      async getMessageMetadata() {
        return { internalDate: '2026-09-13T01:00:00.000Z', labelIds: [] };
      },
      async listMessagesInWindow() {
        throw new Error('not used in this test');
      },
      async getCurrentHistoryId() {
        throw new Error('not used in this test');
      },
    };
    const { submitter } = fakeSubmitter();

    const result = await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(result.outcome).toBe('CAS_LOST_RETRY');
    const row = await readCursorRow(db, accounts.gmailAccountId);
    expect(JSON.parse(row!.cursor_value as string)).toMatchObject({ historyId: 'h-concurrent' });
  });

  it('bootstraps from gmail_connections.watch_history_id when no source_cursors row exists yet', async () => {
    const { db, accounts } = await setup({ watchHistoryId: 'watch-bootstrap' }); // no cursorValue -> no row
    const { client, calls } = fakeHistoryClient({
      historyPages: [{ historyId: 'h-after-bootstrap', records: [] }],
    });
    const { submitter } = fakeSubmitter();

    const result = await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(result.outcome).toBe('SYNCED');
    expect(calls.listHistory).toBe(1);
    const row = await readCursorRow(db, accounts.gmailAccountId);
    expect(JSON.parse(row!.cursor_value as string)).toMatchObject({
      historyId: 'h-after-bootstrap',
    });
  });

  it('routes a first-ever POLL-mode sync (watch_history_id null) through bounded recovery instead of dropping the connectedAt-to-getCurrentHistoryId() gap', async () => {
    // GPT-PM round-1 BLOCKER (2026-09-13): the prior version of this test scripted an EMPTY
    // history/window after the captured current-history-id, so it could not expose the loss
    // window at all -- it passed even against the buggy code that used getCurrentHistoryId()
    // directly as startHistoryId. This version seeds a real message discoverable ONLY via the
    // bounded messages.list/messages.get recovery enumeration (never via listHistory, which is
    // never even called), proving the connectedAt -> current-historyId interval is genuinely
    // covered rather than silently discarded.
    const { db, accounts } = await setup({ watchHistoryId: null }); // no cursorValue -> no row either
    const { client, calls } = fakeHistoryClient({
      windowPages: [{ messages: [{ messageId: 'm-gap', threadId: 't-gap' }] }],
      metadataByMessageId: {
        'm-gap': { internalDate: '2026-09-13T01:45:00.000Z', labelIds: [] },
      },
      currentHistoryId: 'h-poll-bootstrap',
    });
    const { submitter, submitted } = fakeSubmitter();

    const result = await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(result.outcome).toBe('RECOVERED_FROM_INVALID_CURSOR');
    expect(calls.listHistory).toBe(0); // no durable history baseline exists yet -- never attempted
    expect(calls.getCurrentHistoryId).toBe(1);
    expect(submitted).toHaveLength(1);
    const event = NormalizedEventSchema.parse(submitted[0]);
    expect(event.event_type).toBe('MESSAGE_CREATED');
    expect(event.source_event_id).toBe('m-gap');
    if (result.outcome === 'RECOVERED_FROM_INVALID_CURSOR') {
      expect(result.counts).toEqual({ accepted: 1, alreadyAccepted: 0 });
    }
    const row = await readCursorRow(db, accounts.gmailAccountId);
    expect(JSON.parse(row!.cursor_value as string)).toMatchObject({
      historyId: 'h-poll-bootstrap',
    });

    // Re-running the sync must not re-submit the same message as a fresh ACCEPTED -- it is now
    // durably behind the recovered cursor's historyId, so a repeat call must use the normal
    // listHistory path and see nothing new.
    const { client: client2, calls: calls2 } = fakeHistoryClient({
      historyPages: [{ historyId: 'h-poll-bootstrap', records: [] }],
    });
    const result2 = await syncGmailAccountHistory(db, client2, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:05:00.000Z',
    });
    expect(result2.outcome).toBe('SYNCED');
    expect(calls2.listHistory).toBe(1);
    expect(submitted).toHaveLength(1); // still just the one message from the first call
  });

  it('throws GmailHistoryCursorMissingBootstrapError when no gmail_connections row exists at all (the account was never actually connected)', async () => {
    const { db, accounts } = await setup({ skipConnection: true }); // no cursorValue -> no row either
    const { client } = fakeHistoryClient({});
    const { submitter } = fakeSubmitter();

    await expect(
      syncGmailAccountHistory(db, client, submitter, {
        sourceAccountId: accounts.gmailAccountId,
        sourcePolicyId: accounts.gmailPolicyId,
        connectedAt: FIXTURE_NOW,
        now: '2026-09-13T02:00:00.000Z',
      }),
    ).rejects.toThrow(GmailHistoryCursorMissingBootstrapError);
  });
});

describe('syncGmailAccountHistory -- §2.2 step 6: bounded 404/invalid-cursor recovery', () => {
  it('a non-JSON cursor_value routes into bounded recovery instead of crashing with no self-healing route', async () => {
    const { db, accounts } = await setup({ cursorValue: 'this-is-not-json{{{' });
    const { client, calls } = fakeHistoryClient({
      windowPages: [{ messages: [{ messageId: 'm1', threadId: 't1' }] }],
      metadataByMessageId: { m1: { internalDate: '2026-09-13T01:45:00.000Z', labelIds: [] } },
      currentHistoryId: 'h-recovery-bootstrap',
    });
    const { submitter, submitted } = fakeSubmitter();

    const result = await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(calls.listHistory).toBe(0); // never even attempted with an unusable cursor
    expect(result.outcome).toBe('RECOVERED_FROM_INVALID_CURSOR');
    expect(submitted).toHaveLength(1);
  });

  it('a valid-JSON-but-wrong-shape cursor_value also routes into bounded recovery, not an undefined startHistoryId', async () => {
    const { db, accounts } = await setup({ cursorValue: JSON.stringify({ unrelated: 'shape' }) });
    const { client, calls } = fakeHistoryClient({
      windowPages: [{ messages: [] }],
      currentHistoryId: 'h-recovery-bootstrap',
    });
    const { submitter } = fakeSubmitter();

    const result = await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(calls.listHistory).toBe(0);
    expect(result.outcome).toBe('RECOVERED_FROM_INVALID_CURSOR');
  });

  it('counts accumulated on the normal path BEFORE the invalid-cursor error are preserved through recovery, not discarded', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'h1', lastSeenInternalDate: FIXTURE_NOW }),
    });
    // Call 1 succeeds (one page, one real submission), THEN call 2 (page 2) hits an invalid cursor.
    const { client } = fakeHistoryClient({
      historyPages: [
        {
          historyId: 'IGNORED',
          nextPageToken: 'page2',
          records: [
            {
              historyRecordId: 'r1',
              messagesAdded: [{ messageId: 'm-normal', threadId: 't1' }],
              messagesDeleted: [],
              labelsAdded: [],
              labelsRemoved: [],
            },
          ],
        },
      ],
      throwInvalidCursorOnCall: 2,
      metadataByMessageId: {
        'm-normal': { internalDate: '2026-09-13T01:10:00.000Z', labelIds: [] },
        'm-recovered': { internalDate: '2026-09-13T01:20:00.000Z', labelIds: [] },
      },
      windowPages: [{ messages: [{ messageId: 'm-recovered', threadId: 't2' }] }],
      currentHistoryId: 'h-recovery-bootstrap',
    });
    const { submitter, submitted } = fakeSubmitter();

    const result = await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(result.outcome).toBe('RECOVERED_FROM_INVALID_CURSOR');
    expect(submitted).toHaveLength(2); // m-normal (pre-error) AND m-recovered (during recovery)
    if (result.outcome === 'RECOVERED_FROM_INVALID_CURSOR') {
      // Both submissions were fresh ACCEPTEDs -- if the pre-error count were discarded, this
      // would read {accepted: 1, alreadyAccepted: 0} instead of counting both.
      expect(result.counts).toEqual({ accepted: 2, alreadyAccepted: 0 });
    }
  });

  it('recovers via messages.list/messages.get from max(connected_at, cursor.lastSeenInternalDate), classifying every found message as MESSAGE_CREATED', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({
        historyId: 'h-stale',
        lastSeenInternalDate: '2026-09-13T01:00:00.000Z',
      }),
    });
    const { client, calls } = fakeHistoryClient({
      throwInvalidCursorOnCall: 1,
      windowPages: [{ messages: [{ messageId: 'm-recovered', threadId: 't-recovered' }] }],
      metadataByMessageId: {
        'm-recovered': { internalDate: '2026-09-13T01:45:00.000Z', labelIds: [] },
      },
      currentHistoryId: 'h-recovery-bootstrap',
    });
    const { submitter, submitted } = fakeSubmitter();

    const result = await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(result.outcome).toBe('RECOVERED_FROM_INVALID_CURSOR');
    expect(calls.getCurrentHistoryId).toBe(1);
    expect(submitted).toHaveLength(1);
    const event = NormalizedEventSchema.parse(submitted[0]);
    expect(event.event_type).toBe('MESSAGE_CREATED');
    expect(event.occurred_at).toBe('2026-09-13T01:45:00.000Z');

    const row = await readCursorRow(db, accounts.gmailAccountId);
    expect(JSON.parse(row!.cursor_value as string)).toEqual({
      historyId: 'h-recovery-bootstrap',
      lastSeenInternalDate: '2026-09-13T01:45:00.000Z',
    });
  });

  it('never silently imports messages older than max(connected_at, cursor.lastSeenInternalDate) -- the window start is bounded, not Google default full-resync', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({
        historyId: 'h-stale',
        lastSeenInternalDate: '2026-09-13T01:00:00.000Z',
      }),
    });
    let observedAfterIso: string | null = null;
    const client: GmailHistoryClient = {
      async listHistory() {
        throw new GmailHistoryCursorInvalidError('bad-cursor');
      },
      async getMessageMetadata() {
        throw new Error('not used in this test');
      },
      async listMessagesInWindow(opts) {
        observedAfterIso = opts.afterIso;
        return { messages: [] };
      },
      async getCurrentHistoryId() {
        return 'h-recovery';
      },
    };
    const { submitter } = fakeSubmitter();

    await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(observedAfterIso).toBe('2026-09-13T01:00:00.000Z'); // the cursor's own last-seen time, not connectedAt
  });

  it('recovery paginates across multiple listMessagesInWindow pages and dedupes a messageId repeated across pages', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({
        historyId: 'h-stale',
        lastSeenInternalDate: '2026-09-13T01:00:00.000Z',
      }),
    });
    const { client, calls } = fakeHistoryClient({
      throwInvalidCursorOnCall: 1,
      windowPages: [
        { messages: [{ messageId: 'm1', threadId: 't1' }], nextPageToken: 'page2' },
        // m1 repeated across pages (a realistic Gmail pagination edge case) plus a genuinely new m2
        {
          messages: [
            { messageId: 'm1', threadId: 't1' },
            { messageId: 'm2', threadId: 't2' },
          ],
        },
      ],
      metadataByMessageId: {
        m1: { internalDate: '2026-09-13T01:20:00.000Z', labelIds: [] },
        m2: { internalDate: '2026-09-13T01:40:00.000Z', labelIds: [] },
      },
      currentHistoryId: 'h-recovery-bootstrap',
    });
    const { submitter, submitted } = fakeSubmitter();

    const result = await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(calls.listMessagesInWindow).toBe(2);
    expect(submitted).toHaveLength(2); // m1 submitted once despite appearing on both pages
    expect(new Set(submitted.map((e) => e.source_event_id))).toEqual(new Set(['m1', 'm2']));
    expect(result.outcome).toBe('RECOVERED_FROM_INVALID_CURSOR');
    const row = await readCursorRow(db, accounts.gmailAccountId);
    expect(JSON.parse(row!.cursor_value as string)).toEqual({
      historyId: 'h-recovery-bootstrap',
      lastSeenInternalDate: '2026-09-13T01:40:00.000Z', // max across both pages
    });
  });
});

/** Inserts a `gmail_history_sync_progress` row directly, matching migration 0008's full column
 *  set -- used to simulate a checkpoint already left behind by SOME OTHER traversal/invocation,
 *  independent of whatever `syncGmailAccountHistory` itself would produce. */
async function seedProgressRow(
  db: Awaited<ReturnType<typeof setup>>['db'],
  row: {
    sourceAccountId: string;
    mode: 'MAIN' | 'RECOVERY';
    startHistoryId?: string | null;
    windowStart?: string | null;
    prevCursorJson: string | null;
    recoveryHistoryId?: string | null;
    nextPageToken: string | null;
    nextChangeIndex: number;
    accumulatedNewestInternalDate: string;
    updatedAt: string;
  },
) {
  await db
    .prepare(
      `INSERT INTO gmail_history_sync_progress
         (source_account_id, mode, start_history_id, window_start, prev_cursor_json,
          recovery_history_id, next_page_token, next_change_index,
          accumulated_newest_internal_date, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.sourceAccountId,
      row.mode,
      row.startHistoryId ?? null,
      row.windowStart ?? null,
      row.prevCursorJson,
      row.recoveryHistoryId ?? null,
      row.nextPageToken,
      row.nextChangeIndex,
      row.accumulatedNewestInternalDate,
      row.updatedAt,
    )
    .run();
}

async function readProgressRow(
  db: Awaited<ReturnType<typeof setup>>['db'],
  sourceAccountId: string,
) {
  return db
    .prepare('SELECT * FROM gmail_history_sync_progress WHERE source_account_id = ?')
    .bind(sourceAccountId)
    .first<Record<string, unknown> | null>();
}

describe('syncGmailAccountHistory -- resumable per-invocation external-call budget (GPT-PM round-1 MAJOR #1, round-2 MAJOR)', () => {
  it('checkpoints mid-PAGE when the external-call budget is exhausted, then resumes the SAME page on the next invocation instead of re-fetching or re-submitting already-processed changes', async () => {
    // GPT-PM round-2 MAJOR: a page-BOUNDARY budget is not an external-call budget -- Gmail
    // documents history.list as returning up to 100 records per page, and a single page can
    // exceed the Free-plan ceiling before any page boundary is reached. This test puts BOTH
    // messages in ONE page and proves the budget stops mid-page, not just between pages.
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'h0', lastSeenInternalDate: FIXTURE_NOW }),
    });
    const { submitter, submitted } = fakeSubmitter();

    // --- Invocation 1: ONE page containing 2 MESSAGE_ADDED changes (cost 2 each); budget=3 means
    //     1 (page fetch) + 2 (m1) = 3 fits, but + 2 more for m2 would be 5 > 3. ---
    const calls1: Array<{ startHistoryId: string; pageToken?: string }> = [];
    const client1: GmailHistoryClient = {
      async listHistory(opts) {
        calls1.push(opts);
        if (calls1.length > 1) {
          throw new Error('invocation 1 must not fetch a second page');
        }
        return {
          historyId: 'h-final',
          records: [
            {
              historyRecordId: 'r1',
              messagesAdded: [
                { messageId: 'm1', threadId: 't1' },
                { messageId: 'm2', threadId: 't2' },
              ],
              messagesDeleted: [],
              labelsAdded: [],
              labelsRemoved: [],
            },
          ],
        };
      },
      async getMessageMetadata(opts) {
        if (opts.messageId === 'm1') {
          return { internalDate: '2026-09-13T01:10:00.000Z', labelIds: [] };
        }
        throw new Error(`invocation 1 must not process ${opts.messageId}`);
      },
      async listMessagesInWindow() {
        throw new Error('not used in this test');
      },
      async getCurrentHistoryId() {
        throw new Error('not used in this test');
      },
    };

    const result1 = await syncGmailAccountHistory(db, client1, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
      maxExternalCallsPerInvocation: 3,
    });

    expect(result1.outcome).toBe('PARTIAL_PROGRESS');
    if (result1.outcome === 'PARTIAL_PROGRESS') {
      expect(result1.counts).toEqual({ accepted: 1, alreadyAccepted: 0 });
    }
    expect(calls1).toHaveLength(1); // ONE page fetch, budget stopped WITHIN it
    expect(submitted.map((e) => e.source_event_id)).toEqual(['m1']); // m2 NOT yet processed

    // cursor_value is UNTOUCHED -- §2.2's own invariant, preserved by the checkpoint mechanism.
    const rowAfter1 = await readCursorRow(db, accounts.gmailAccountId);
    expect(JSON.parse(rowAfter1!.cursor_value as string)).toEqual({
      historyId: 'h0',
      lastSeenInternalDate: FIXTURE_NOW,
    });

    const progressRow = await readProgressRow(db, accounts.gmailAccountId);
    expect(progressRow).toMatchObject({
      mode: 'MAIN',
      start_history_id: 'h0',
      next_page_token: null, // re-fetch the SAME (first) page, not a "next" one
      next_change_index: 1, // resume at m2, skip re-processing m1
      accumulated_newest_internal_date: '2026-09-13T01:10:00.000Z',
    });

    // --- Invocation 2: fresh client re-scripted with the SAME page; must re-fetch it exactly
    //     once, process ONLY m2 (never re-submit m1), and complete the traversal. ---
    const calls2: Array<{ startHistoryId: string; pageToken?: string }> = [];
    const client2: GmailHistoryClient = {
      async listHistory(opts) {
        calls2.push(opts);
        if (calls2.length > 1) {
          throw new Error('invocation 2 must complete in a single re-fetched page');
        }
        return {
          historyId: 'h-final',
          records: [
            {
              historyRecordId: 'r1',
              messagesAdded: [
                { messageId: 'm1', threadId: 't1' },
                { messageId: 'm2', threadId: 't2' },
              ],
              messagesDeleted: [],
              labelsAdded: [],
              labelsRemoved: [],
            },
          ],
        };
      },
      async getMessageMetadata(opts) {
        if (opts.messageId === 'm2') {
          return { internalDate: '2026-09-13T01:20:00.000Z', labelIds: [] };
        }
        throw new Error(`invocation 2 must not re-process ${opts.messageId}`);
      },
      async listMessagesInWindow() {
        throw new Error('not used in this test');
      },
      async getCurrentHistoryId() {
        throw new Error('not used in this test');
      },
    };

    const result2 = await syncGmailAccountHistory(db, client2, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:05:00.000Z',
      maxExternalCallsPerInvocation: 10,
    });

    expect(result2.outcome).toBe('SYNCED');
    expect(calls2).toHaveLength(1);
    expect(calls2[0]).toEqual({ startHistoryId: 'h0' }); // re-fetched the SAME first page
    expect(submitted.map((e) => e.source_event_id)).toEqual(['m1', 'm2']); // m1 never resubmitted

    const rowAfter2 = await readCursorRow(db, accounts.gmailAccountId);
    expect(JSON.parse(rowAfter2!.cursor_value as string)).toEqual({
      historyId: 'h-final',
      lastSeenInternalDate: '2026-09-13T01:20:00.000Z',
    });
    expect(await readProgressRow(db, accounts.gmailAccountId)).toBeNull(); // cleaned up
  });

  it('discards a checkpoint that no longer matches the current cursor state instead of resuming from stale assumptions', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'h0', lastSeenInternalDate: FIXTURE_NOW }),
    });
    // A checkpoint left behind by a superseded traversal -- anchored to a DIFFERENT
    // start_history_id/prev_cursor_json than the current source_cursors state.
    await seedProgressRow(db, {
      sourceAccountId: accounts.gmailAccountId,
      mode: 'MAIN',
      startHistoryId: 'stale-history-id',
      prevCursorJson: JSON.stringify({
        historyId: 'stale-history-id',
        lastSeenInternalDate: '2026-09-01T00:00:00.000Z',
      }),
      nextPageToken: 'stale-page-token',
      nextChangeIndex: 2,
      accumulatedNewestInternalDate: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });

    const calls: Array<{ startHistoryId: string; pageToken?: string }> = [];
    const client: GmailHistoryClient = {
      async listHistory(opts) {
        calls.push(opts);
        return { historyId: 'h-final', records: [] };
      },
      async getMessageMetadata() {
        throw new Error('not used in this test');
      },
      async listMessagesInWindow() {
        throw new Error('not used in this test');
      },
      async getCurrentHistoryId() {
        throw new Error('not used in this test');
      },
    };
    const { submitter } = fakeSubmitter();

    const result = await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(result.outcome).toBe('SYNCED');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ startHistoryId: 'h0' }); // fresh start, NOT resumed from 'stale-page-token'
  });

  it('a stale traversal never overwrites a different, newer checkpoint already in place (GPT-PM round-2 MAJOR: checkpoint write fencing)', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'hA', lastSeenInternalDate: FIXTURE_NOW }),
    });
    // Simulates a NEWER traversal (anchored to 'hB') that already checkpointed its own progress
    // -- as if the authoritative cursor had already moved past 'hA' by the time this one runs.
    await seedProgressRow(db, {
      sourceAccountId: accounts.gmailAccountId,
      mode: 'MAIN',
      startHistoryId: 'hB',
      prevCursorJson: JSON.stringify({
        historyId: 'hB',
        lastSeenInternalDate: '2026-09-13T01:30:00.000Z',
      }),
      nextPageToken: 'page-b-2',
      nextChangeIndex: 3,
      accumulatedNewestInternalDate: '2026-09-13T01:30:00.000Z',
      updatedAt: '2026-09-13T01:30:00.000Z',
    });

    // A traversal anchored to the CURRENT cursor ('hA') that exhausts its budget and tries to
    // write its OWN checkpoint -- it must not clobber 'hB'.
    const client: GmailHistoryClient = {
      async listHistory() {
        return {
          historyId: 'IGNORED',
          records: [
            {
              historyRecordId: 'r1',
              messagesAdded: [
                { messageId: 'm1', threadId: 't1' },
                { messageId: 'm2', threadId: 't2' },
              ],
              messagesDeleted: [],
              labelsAdded: [],
              labelsRemoved: [],
            },
          ],
        };
      },
      async getMessageMetadata() {
        return { internalDate: '2026-09-13T01:10:00.000Z', labelIds: [] };
      },
      async listMessagesInWindow() {
        throw new Error('not used in this test');
      },
      async getCurrentHistoryId() {
        throw new Error('not used in this test');
      },
    };
    const { submitter } = fakeSubmitter();

    const result = await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
      maxExternalCallsPerInvocation: 3, // stops after m1, before m2
    });

    expect(result.outcome).toBe('PARTIAL_PROGRESS');
    const row = await readProgressRow(db, accounts.gmailAccountId);
    // 'hB's checkpoint survives untouched -- the mismatched 'hA' write was fenced out (0 rows
    // affected), not silently applied on top of it.
    expect(row).toMatchObject({
      start_history_id: 'hB',
      next_page_token: 'page-b-2',
      next_change_index: 3,
    });
  });

  it("a stale traversal's cleanup delete never removes a different, newer checkpoint's row (GPT-PM round-2 MAJOR: checkpoint delete fencing)", async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({ historyId: 'hA', lastSeenInternalDate: FIXTURE_NOW }),
    });
    await seedProgressRow(db, {
      sourceAccountId: accounts.gmailAccountId,
      mode: 'MAIN',
      startHistoryId: 'hB',
      prevCursorJson: JSON.stringify({
        historyId: 'hB',
        lastSeenInternalDate: '2026-09-13T01:30:00.000Z',
      }),
      nextPageToken: 'page-b-2',
      nextChangeIndex: 3,
      accumulatedNewestInternalDate: '2026-09-13T01:30:00.000Z',
      updatedAt: '2026-09-13T01:30:00.000Z',
    });

    // A traversal anchored to the CURRENT cursor ('hA') that completes normally -- its own
    // cleanup delete is fenced to ITS OWN anchor ('hA'), so 'hB's row must survive.
    const client: GmailHistoryClient = {
      async listHistory() {
        return { historyId: 'h-final', records: [] };
      },
      async getMessageMetadata() {
        throw new Error('not used in this test');
      },
      async listMessagesInWindow() {
        throw new Error('not used in this test');
      },
      async getCurrentHistoryId() {
        throw new Error('not used in this test');
      },
    };
    const { submitter } = fakeSubmitter();

    const result = await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(result.outcome).toBe('SYNCED');
    const row = await readProgressRow(db, accounts.gmailAccountId);
    expect(row).toMatchObject({ start_history_id: 'hB' }); // survived the unrelated hA traversal's cleanup
  });

  it('recovery (404/invalid-cursor path) also checkpoints mid-window-page and resumes without re-deriving getCurrentHistoryId() (GPT-PM round-2 MAJOR: recovery needs the same bounded-progress property)', async () => {
    const { db, accounts } = await setup({
      cursorValue: JSON.stringify({
        historyId: 'h-stale',
        lastSeenInternalDate: '2026-09-13T01:00:00.000Z',
      }),
    });
    const { submitter, submitted } = fakeSubmitter();

    // --- Invocation 1: the cursor is reported invalid, triggering recovery. ONE window page
    //     with 2 messages; budget stops mid-page after the first. ---
    const calls1 = { listMessagesInWindow: 0, getCurrentHistoryId: 0 };
    const client1: GmailHistoryClient = {
      async listHistory() {
        throw new GmailHistoryCursorInvalidError('h-stale');
      },
      async getMessageMetadata(opts) {
        if (opts.messageId === 'm1') {
          return { internalDate: '2026-09-13T01:10:00.000Z', labelIds: [] };
        }
        throw new Error(`invocation 1 must not process ${opts.messageId}`);
      },
      async listMessagesInWindow() {
        calls1.listMessagesInWindow += 1;
        if (calls1.listMessagesInWindow > 1) throw new Error('must not fetch a second window page');
        return {
          messages: [
            { messageId: 'm1', threadId: 't1' },
            { messageId: 'm2', threadId: 't2' },
          ],
        };
      },
      async getCurrentHistoryId() {
        calls1.getCurrentHistoryId += 1;
        return 'h-recovery-bootstrap';
      },
    };

    const result1 = await syncGmailAccountHistory(db, client1, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
      maxExternalCallsPerInvocation: 3, // 1 (window fetch) + 2 (m1) = 3, m2 would exceed
    });

    expect(result1.outcome).toBe('PARTIAL_PROGRESS');
    expect(calls1.getCurrentHistoryId).toBe(1);
    expect(submitted.map((e) => e.source_event_id)).toEqual(['m1']);

    const progressRow = await readProgressRow(db, accounts.gmailAccountId);
    expect(progressRow).toMatchObject({
      mode: 'RECOVERY',
      window_start: '2026-09-13T01:00:00.000Z',
      recovery_history_id: 'h-recovery-bootstrap',
      next_page_token: null,
      next_change_index: 1,
    });

    // cursor_value is still the STALE one -- recovery never advances it until it fully completes.
    const rowAfter1 = await readCursorRow(db, accounts.gmailAccountId);
    expect(JSON.parse(rowAfter1!.cursor_value as string)).toMatchObject({ historyId: 'h-stale' });

    // --- Invocation 2: must resume WITHOUT calling getCurrentHistoryId() again (it must reuse
    //     the ALREADY-captured 'h-recovery-bootstrap'), re-fetch the SAME window page, and
    //     process only m2. ---
    const calls2 = { listMessagesInWindow: 0, getCurrentHistoryId: 0 };
    const client2: GmailHistoryClient = {
      async listHistory() {
        // cursor_value is still the STALE one (recovery hasn't completed), so a real retry
        // re-triggers the identical 404 -- syncGmailAccountHistory's own entry point has no
        // other way to know a recovery is already in progress.
        throw new GmailHistoryCursorInvalidError('h-stale');
      },
      async getMessageMetadata(opts) {
        if (opts.messageId === 'm2') {
          return { internalDate: '2026-09-13T01:20:00.000Z', labelIds: [] };
        }
        throw new Error(`invocation 2 must not re-process ${opts.messageId}`);
      },
      async listMessagesInWindow() {
        calls2.listMessagesInWindow += 1;
        if (calls2.listMessagesInWindow > 1) throw new Error('must not fetch a second window page');
        return {
          messages: [
            { messageId: 'm1', threadId: 't1' },
            { messageId: 'm2', threadId: 't2' },
          ],
        };
      },
      async getCurrentHistoryId() {
        calls2.getCurrentHistoryId += 1;
        throw new Error('invocation 2 must not re-derive getCurrentHistoryId()');
      },
    };

    const result2 = await syncGmailAccountHistory(db, client2, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:05:00.000Z',
      maxExternalCallsPerInvocation: 10,
    });

    expect(result2.outcome).toBe('RECOVERED_FROM_INVALID_CURSOR');
    expect(calls2.getCurrentHistoryId).toBe(0);
    expect(calls2.listMessagesInWindow).toBe(1);
    expect(submitted.map((e) => e.source_event_id)).toEqual(['m1', 'm2']); // m1 never resubmitted

    const rowAfter2 = await readCursorRow(db, accounts.gmailAccountId);
    expect(JSON.parse(rowAfter2!.cursor_value as string)).toEqual({
      historyId: 'h-recovery-bootstrap',
      lastSeenInternalDate: '2026-09-13T01:20:00.000Z',
    });
    expect(await readProgressRow(db, accounts.gmailAccountId)).toBeNull();
  });
});
