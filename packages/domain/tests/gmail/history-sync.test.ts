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

  it('falls back to getCurrentHistoryId() when gmail_connections exists but watch_history_id is null (POLL mode, no watch ever registered)', async () => {
    const { db, accounts } = await setup({ watchHistoryId: null }); // no cursorValue -> no row either
    const { client, calls } = fakeHistoryClient({
      historyPages: [{ historyId: 'h-after-bootstrap', records: [] }],
      currentHistoryId: 'h-poll-bootstrap',
    });
    const { submitter } = fakeSubmitter();

    const result = await syncGmailAccountHistory(db, client, submitter, {
      sourceAccountId: accounts.gmailAccountId,
      sourcePolicyId: accounts.gmailPolicyId,
      connectedAt: FIXTURE_NOW,
      now: '2026-09-13T02:00:00.000Z',
    });

    expect(result.outcome).toBe('SYNCED');
    expect(calls.getCurrentHistoryId).toBe(1);
    const row = await readCursorRow(db, accounts.gmailAccountId);
    expect(JSON.parse(row!.cursor_value as string)).toMatchObject({
      historyId: 'h-after-bootstrap',
    });
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
