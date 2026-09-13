/* global crypto */
import type { D1Database } from '@cloudflare/workers-types';
import { NormalizedEventSchema, SCHEMA_VERSION, type NormalizedEvent } from '@pdos/contracts';

/**
 * Crash-safe cursor sync + Gmail-history-to-`NormalizedEvent` normalization (proposal §2.2/§2.3,
 * `governance/plans/G3_GMAIL_CONNECTOR_PROPOSAL.md`). Pure orchestration logic only -- the real
 * `fetch`-backed Gmail API client and the real HTTP POST to `/ingest/gmail` are both injected
 * (`GmailHistoryClient`, `GmailEventSubmitter`), mirroring `oauth.ts`'s `GoogleOAuthClient` DI
 * shape exactly. The real implementations live in the not-yet-created `services/gmail-connector`
 * Worker (proposal §2.1's ingress boundary: this connector calls `POST /ingest/gmail`, never
 * `ingestEvent()` directly).
 *
 * Design decisions this module makes that the proposal's own §2.2/§2.3 text does not state
 * explicitly (recorded here and in `core/DECISION_LOG.md`, not invented silently):
 *
 * 1. `occurred_at` sourcing. Gmail's `history.list` response does not carry `internalDate` (Google's
 *    own API reference: the embedded `Message` stub on a history record has only `id`/`threadId`).
 *    The proposal's own quota budget (`§2.9`: "`history.list` (2 units) + `messages.get` (20 units)
 *    per new message") confirms the design already accounts for one `messages.get` call per NEW
 *    message -- that call is this module's actual source for `occurred_at` on `MESSAGE_CREATED`
 *    (`GmailMessageMetadata.internalDate`). For `MESSAGE_DELETED` and `MESSAGE_UPDATED` (label
 *    changes), Gmail exposes no per-signal timestamp at all -- neither `history.list` nor a history
 *    record's own `id` (a monotonic counter, not a time) carries one, and the budget model does not
 *    account for an extra `messages.get` on those paths. `occurred_at` for those two event types is
 *    therefore the sync's own processing time (`opts.now`), same value as `received_at`.
 *
 *    GPT-PM round-1 MAJOR (2026-09-13): flagged this as a real violation of `NormalizedEvent`'s own
 *    provenance split (`occurred_at` = provider time, `received_at` = transport time,
 *    `packages/contracts/src/event.ts`) -- not merely an approximation, because a downstream
 *    latency/ordering consumer cannot distinguish "this really happened now" from "we don't know
 *    when this happened." GPT-PM's own suggested remedy is a governed CONTRACT change (a nullable/
 *    qualified occurrence time, or an explicit timestamp-provenance/quality field) -- NOT something
 *    this module can decide unilaterally: `NormalizedEvent` is shared with the Telegram connector
 *    and `services/ingest`, so a schema change here is real scope beyond this checkpoint's own
 *    §2.2/§2.3 boundary (also touches `SCHEMA_VERSION`, every other event producer/consumer, and
 *    every test fixture across the repo that constructs a `NormalizedEvent`). Deliberately NOT
 *    implemented in this checkpoint's remediation for that reason -- escalated back to GPT-PM as
 *    product owner in round 2 with two concrete options rather than decided silently: (a) accept
 *    this as a documented, narrowly-scoped limitation for checkpoint 5 specifically, with a tracked
 *    cross-cutting follow-up gate to add the contract's own provenance/quality field once its shape
 *    is agreed for every producer, not just Gmail; or (b) require the contract change as part of
 *    closing this gate, in which case the additive field this module would set is
 *    `occurred_at_quality: 'ESTIMATED_FROM_RECEIPT'` on these two paths (default
 *    `'PROVIDER_REPORTED'` everywhere else, so no existing producer/consumer needs to change).
 * 2. `direction` sourcing. Not addressed by §2.3's matrix at all. `MESSAGE_CREATED` derives it from
 *    the SAME `messages.get` call already budgeted for `occurred_at` (`labelIds.includes('SENT')`).
 *    `MESSAGE_DELETED`/`MESSAGE_UPDATED` default to `'INBOUND'` -- deriving it correctly would need
 *    either a persisted message-direction registry or another `messages.get` call per label change,
 *    neither of which the proposal's budget model accounts for, and `direction` is not part of
 *    `idempotencyKey()` so this default cannot cause a duplicate/dropped event, only a wrong UI hint
 *    on an already-rare path (a label change on an outbound message, before that message's own
 *    CREATED event, however it was sourced, ever recorded direction correctly elsewhere). A cheaper
 *    alternative exists and is deliberately declined: reading the message's own already-durable
 *    `MESSAGE_CREATED` row back from `ingest_events` to recover its real direction. Declined because
 *    it would add a D1 read on this module's hot path to fix a UI hint, and this module otherwise
 *    never reads `ingest_events` at all -- not because no cheaper option was considered.
 * 3. Per-event permanent-failure handling: NOT built. A `NormalizedEventSchema.parse()` failure
 *    (a genuine internal-construction bug, expected to be unreachable in practice) or a submit
 *    rejection thrown by the injected `GmailEventSubmitter` both propagate uncaught, exactly like
 *    any other failure -- there is no skip/dead-letter path, so a message that permanently and
 *    reproducibly fails to submit wedges this account's sync indefinitely (every retry re-derives
 *    the same failure before the cursor can ever advance past it). Accepted as an explicit, narrow
 *    limitation for this checkpoint rather than solved: `GmailEventSubmitResult` has no `REJECTED`
 *    variant today (the proposal's §2.1 ingress contract does not define one), and a real
 *    quarantine mechanism needs new durable state (a dead-letter marker) this checkpoint's schema
 *    does not have -- out of §2.2/§2.3's stated scope. Revisit if this proves to matter in practice.
 * 4. Per-invocation work is now BOUNDED (fixed 2026-09-13, GPT-PM round-1 MAJOR -- the original
 *    "unbounded work, accepted as an unmeasured limitation" framing was rejected: Cloudflare's own
 *    current documentation gives Workers Free 50 subrequests/invocation, a real and current
 *    ceiling, not a hypothesis, and every `MESSAGE_ADDED` costs one `messages.get` subrequest on
 *    top of `history.list` itself -- an ordinary backlog of ~50 new messages already exceeds it).
 *    `SyncGmailAccountHistoryOptions.maxPagesPerInvocation` (optional; `undefined` = unbounded,
 *    the prior behavior) caps how many `history.list` pages the MAIN traversal processes in one
 *    call. When the budget is exhausted before the final page, progress is durably checkpointed
 *    in `gmail_history_sync_progress` -- a table OUTSIDE `cursor_value`, so this does not violate
 *    §2.2 (which forbids advancing the AUTHORITATIVE cursor mid-traversal, not persisting other
 *    resume state) -- and the call returns `PARTIAL_PROGRESS`; the next invocation resumes from
 *    the checkpoint's `next_page_token` instead of restarting page 1, fenced against the CURRENT
 *    `source_cursors` state (a stale/foreign checkpoint from a superseded traversal is discarded,
 *    never resumed against assumptions that no longer hold). Deliberately scoped to the MAIN
 *    traversal only -- `recoverFromInvalidCursor`'s bounded `messages.list` enumeration is NOT
 *    checkpointed by this mechanism; that recovery path already runs in a single bounded window
 *    (`[connectedAt, getCurrentHistoryId())`) rather than an open-ended live-tailing traversal, so
 *    its own subrequest growth is bounded by the SIZE of one gap, not by an unbounded live stream,
 *    and is judged a narrower, acceptable residual risk for this checkpoint (flagged to GPT-PM for
 *    explicit confirmation rather than silently decided).
 *
 * `content_locator.ref = message.id`: NOT a gap -- proposal §2.8 states the drill-down endpoint
 * "resolves the opaque `content_locator.ref` to a real Gmail `message.id`/`thread.id`", so this is
 * the proposal's own stated design, merely applied here rather than restated.
 */

// ---------------------------------------------------------------------------------------------
// Injected Gmail API client (real `fetch`-backed implementation deferred to services/gmail-connector)
// ---------------------------------------------------------------------------------------------

export interface GmailMessageRef {
  messageId: string;
  threadId: string;
}

export interface GmailHistoryRecord {
  /** The history record's OWN id (`History.id`) -- distinct from the account-level cursor
   *  `historyId` returned by `history.list` itself. Used as the `source_version` discriminator
   *  base for `MESSAGE_UPDATED` events (§2.3). */
  historyRecordId: string;
  messagesAdded: GmailMessageRef[];
  messagesDeleted: GmailMessageRef[];
  labelsAdded: GmailMessageRef[];
  labelsRemoved: GmailMessageRef[];
}

export interface GmailHistoryPage {
  /** Only meaningful (safe to persist as the new cursor) on the FINAL page -- the one with no
   *  `nextPageToken` (proposal §2.2, verified against Google's own API reference this round). */
  historyId: string;
  nextPageToken?: string;
  records: GmailHistoryRecord[];
}

export interface GmailMessageMetadata {
  /** ISO-8601 with offset, matching `NormalizedEvent.occurred_at`'s own format -- conversion from
   *  Gmail's raw epoch-millisecond-string `internalDate` is the real client implementation's job,
   *  not this module's. */
  internalDate: string;
  labelIds: string[];
}

export interface GmailListMessagesInWindowResult {
  messages: GmailMessageRef[];
  nextPageToken?: string;
}

/**
 * Thrown by a real `listHistory` implementation when Gmail reports an expired/invalid history
 * cursor (404) for the given `startHistoryId` -- the proposal §2.2 step-6 trigger for bounded
 * gap recovery. A real implementation MUST throw this specific class, not a generic `Error`, or
 * `syncGmailAccountHistory` cannot distinguish "cursor is stale" from any other failure.
 */
export class GmailHistoryCursorInvalidError extends Error {
  readonly startHistoryId: string;
  constructor(startHistoryId: string) {
    super(
      `Gmail history.list reported an expired/invalid cursor for startHistoryId=${startHistoryId}`,
    );
    this.name = 'GmailHistoryCursorInvalidError';
    this.startHistoryId = startHistoryId;
  }
}

export interface GmailHistoryClient {
  /** Throws `GmailHistoryCursorInvalidError` on a 404/invalid cursor -- never returns a sentinel
   *  value for that case. */
  listHistory(opts: { startHistoryId: string; pageToken?: string }): Promise<GmailHistoryPage>;
  getMessageMetadata(opts: { messageId: string }): Promise<GmailMessageMetadata>;
  /** Bounded gap-recovery enumeration (proposal §2.2 step 6): messages at or after `afterIso`,
   *  via `messages.list`'s date-range query. Deliberately UNBOUNDED at the upper end -- an earlier
   *  version bounded it at the sync's own entry timestamp, which left a real window (between that
   *  timestamp and `getCurrentHistoryId()`'s own later call) where an arriving message would be
   *  excluded from this enumeration AND already "in the past" relative to the recovered cursor,
   *  i.e. silently and permanently lost. Over-inclusion here is always safe: any message already
   *  covered by a prior sync resolves to `ALREADY_ACCEPTED` via `idempotencyKey()`. Cannot see
   *  messages that were both created AND deleted inside the window -- Gmail's `messages.list` only
   *  enumerates currently-existing messages, a documented limitation of this recovery path, not a
   *  defect in it. */
  listMessagesInWindow(opts: {
    afterIso: string;
    pageToken?: string;
  }): Promise<GmailListMessagesInWindowResult>;
  /** The account's CURRENT `historyId` (`users.getProfile().historyId`), read once at the START
   *  of gap recovery -- before enumerating `listMessagesInWindow` -- so the recovered cursor never
   *  claims coverage past the point recovery actually began, even if new messages arrive while
   *  recovery is still enumerating. */
  getCurrentHistoryId(): Promise<string>;
}

// ---------------------------------------------------------------------------------------------
// Injected event submitter (real implementation posts to `/ingest/gmail`, never calls `ingestEvent()`)
// ---------------------------------------------------------------------------------------------

export type GmailEventSubmitResult =
  { status: 'ACCEPTED'; eventId: string } | { status: 'ALREADY_ACCEPTED'; eventId: string };

export interface GmailEventSubmitter {
  submit(event: NormalizedEvent): Promise<GmailEventSubmitResult>;
}

// ---------------------------------------------------------------------------------------------
// Cursor value (opaque `source_cursors.cursor_value` JSON, proposal §2.2)
// ---------------------------------------------------------------------------------------------

export interface GmailCursorValue {
  historyId: string;
  lastSeenInternalDate: string;
}

export class GmailHistoryCursorMissingBootstrapError extends Error {
  readonly sourceAccountId: string;
  constructor(sourceAccountId: string) {
    super(
      `No gmail_connections row for source_account_id=${sourceAccountId}; the account was never ` +
        `actually connected, so there is nothing to bootstrap a Gmail history sync from`,
    );
    this.name = 'GmailHistoryCursorMissingBootstrapError';
    this.sourceAccountId = sourceAccountId;
  }
}

/**
 * A minimal shape check, not a full schema -- `source_cursors.cursor_value` is a bare opaque
 * `TEXT` column shared with the Telegram connector by design (migration 0001's own comment), so
 * this module cannot assume every row it reads was written by itself. A malformed/foreign-shaped
 * value must not silently produce `undefined` fields fed into `history.list`; see `tryParseCursor`.
 */
function isValidCursorValue(value: unknown): value is GmailCursorValue {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.historyId === 'string' &&
    candidate.historyId.length > 0 &&
    typeof candidate.lastSeenInternalDate === 'string' &&
    !Number.isNaN(Date.parse(candidate.lastSeenInternalDate))
  );
}

/** `null` for anything that isn't valid JSON matching `GmailCursorValue`'s shape -- never throws,
 *  so a corrupted/foreign cursor value routes into the SAME bounded-recovery path as an
 *  explicit 404, rather than crashing the traversal with no self-healing route. */
function tryParseCursor(rawJson: string): GmailCursorValue | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  return isValidCursorValue(parsed) ? parsed : null;
}

async function readCursor(
  db: D1Database,
  sourceAccountId: string,
): Promise<{ cursor: GmailCursorValue | null; rawJson: string | null; malformed: boolean }> {
  const row = await db
    .prepare(`SELECT cursor_value FROM source_cursors WHERE source_account_id = ?`)
    .bind(sourceAccountId)
    .first<{ cursor_value: string | null }>();
  if (row === null || row.cursor_value === null) {
    return { cursor: null, rawJson: null, malformed: false };
  }
  const cursor = tryParseCursor(row.cursor_value);
  return { cursor, rawJson: row.cursor_value, malformed: cursor === null };
}

/**
 * CAS-advance: one UPSERT handles both "no row yet" (first-ever sync) and "row exists at the
 * expected previous value" uniformly. `WHERE source_cursors.cursor_value IS ?` (not `=`) so a
 * `NULL` previous value (a pre-existing row with no cursor set) compares correctly -- SQL `=`
 * never matches `NULL`, `IS` does. A losing concurrent writer's `INSERT ... ON CONFLICT DO UPDATE`
 * naturally affects zero rows because the row's actual `cursor_value` no longer matches what this
 * caller expected, exactly the same CAS-loss semantics as `push-lease.ts`'s token fencing.
 */
async function advanceCursor(
  db: D1Database,
  sourceAccountId: string,
  prevRawJson: string | null,
  next: GmailCursorValue,
  now: string,
): Promise<boolean> {
  const nextJson = JSON.stringify(next);
  const result = await db
    .prepare(
      `INSERT INTO source_cursors (source_account_id, cursor_value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (source_account_id) DO UPDATE SET
         cursor_value = excluded.cursor_value,
         updated_at = excluded.updated_at
       WHERE source_cursors.cursor_value IS ?`,
    )
    .bind(sourceAccountId, nextJson, now, prevRawJson)
    .run();
  return result.meta.changes === 1;
}

function maxIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

// ---------------------------------------------------------------------------------------------
// §2.3 normalization matrix
// ---------------------------------------------------------------------------------------------

/**
 * A discriminated union rather than one flat shape with an always-present `historyRecordId`:
 * `historyRecordId` is only meaningful for the two label kinds (it feeds `source_version`'s
 * discriminator). Giving `MESSAGE_ADDED`/`MESSAGE_DELETED` a real field they never read invites a
 * silent bug the moment either ever gains a `historyRecordId`-derived value -- see the recovery
 * path below, which constructs a `MESSAGE_ADDED` change with no history record at all.
 */
type PendingChange =
  | { changeKind: 'MESSAGE_ADDED'; messageId: string; threadId: string }
  | { changeKind: 'MESSAGE_DELETED'; messageId: string; threadId: string }
  | { changeKind: 'LABEL_ADDED'; messageId: string; threadId: string; historyRecordId: string }
  | { changeKind: 'LABEL_REMOVED'; messageId: string; threadId: string; historyRecordId: string };

function dedupedRefs(refs: GmailMessageRef[]): GmailMessageRef[] {
  const seen = new Set<string>();
  const result: GmailMessageRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.messageId)) continue;
    seen.add(ref.messageId);
    result.push(ref);
  }
  return result;
}

/**
 * One `NormalizedEvent` per (message, change-kind) pair, never merged (§2.3). Dedupes each of the
 * four ref lists by `messageId` WITHIN one history record first -- "ALL labels added to this
 * message within this one history record collapse into ONE canonical `MESSAGE_UPDATED` event".
 */
function classifyHistoryRecord(record: GmailHistoryRecord): PendingChange[] {
  const changes: PendingChange[] = [];
  for (const ref of dedupedRefs(record.messagesAdded)) {
    changes.push({ changeKind: 'MESSAGE_ADDED', messageId: ref.messageId, threadId: ref.threadId });
  }
  for (const ref of dedupedRefs(record.messagesDeleted)) {
    changes.push({
      changeKind: 'MESSAGE_DELETED',
      messageId: ref.messageId,
      threadId: ref.threadId,
    });
  }
  for (const ref of dedupedRefs(record.labelsAdded)) {
    changes.push({
      changeKind: 'LABEL_ADDED',
      messageId: ref.messageId,
      threadId: ref.threadId,
      historyRecordId: record.historyRecordId,
    });
  }
  for (const ref of dedupedRefs(record.labelsRemoved)) {
    changes.push({
      changeKind: 'LABEL_REMOVED',
      messageId: ref.messageId,
      threadId: ref.threadId,
      historyRecordId: record.historyRecordId,
    });
  }
  return changes;
}

interface BuildEventContext {
  sourceAccountId: string;
  sourcePolicyId: string;
  now: string;
}

async function buildEventForChange(
  historyClient: GmailHistoryClient,
  change: PendingChange,
  ctx: BuildEventContext,
): Promise<NormalizedEvent> {
  const base = {
    event_id: crypto.randomUUID(),
    source: 'gmail' as const,
    source_account_id: ctx.sourceAccountId,
    source_event_id: change.messageId,
    source_thread_id: change.threadId,
    received_at: ctx.now,
    content_locator: { kind: 'SOURCE_REF' as const, ref: change.messageId },
    routing_hints: [],
    source_policy_id: ctx.sourcePolicyId,
    trace_id: crypto.randomUUID(),
    schema_version: SCHEMA_VERSION,
  };

  switch (change.changeKind) {
    case 'MESSAGE_ADDED': {
      const metadata = await historyClient.getMessageMetadata({ messageId: change.messageId });
      return NormalizedEventSchema.parse({
        ...base,
        event_type: 'MESSAGE_CREATED',
        direction: metadata.labelIds.includes('SENT') ? 'OUTBOUND' : 'INBOUND',
        occurred_at: metadata.internalDate,
        source_version: null,
      });
    }
    case 'MESSAGE_DELETED':
      return NormalizedEventSchema.parse({
        ...base,
        event_type: 'MESSAGE_DELETED',
        direction: 'INBOUND',
        occurred_at: ctx.now,
        source_version: null,
      });
    case 'LABEL_ADDED':
      return NormalizedEventSchema.parse({
        ...base,
        event_type: 'MESSAGE_UPDATED',
        direction: 'INBOUND',
        occurred_at: ctx.now,
        source_version: `${change.historyRecordId}:LABEL_ADDED`,
      });
    case 'LABEL_REMOVED':
      return NormalizedEventSchema.parse({
        ...base,
        event_type: 'MESSAGE_UPDATED',
        direction: 'INBOUND',
        occurred_at: ctx.now,
        source_version: `${change.historyRecordId}:LABEL_REMOVED`,
      });
  }
}

async function submitChange(
  historyClient: GmailHistoryClient,
  submitter: GmailEventSubmitter,
  change: PendingChange,
  ctx: BuildEventContext,
  counts: GmailHistorySyncCounts,
): Promise<string | null> {
  const event = await buildEventForChange(historyClient, change, ctx);
  const result = await submitter.submit(event);
  if (result.status === 'ACCEPTED') counts.accepted += 1;
  else counts.alreadyAccepted += 1;
  return event.event_type === 'MESSAGE_CREATED' ? event.occurred_at : null;
}

// ---------------------------------------------------------------------------------------------
// Top-level orchestration (§2.2 steps 1-6)
// ---------------------------------------------------------------------------------------------

export interface GmailHistorySyncCounts {
  accepted: number;
  alreadyAccepted: number;
}

export type SyncGmailAccountHistoryResult =
  | { outcome: 'SYNCED'; counts: GmailHistorySyncCounts }
  | { outcome: 'CAS_LOST_RETRY'; counts: GmailHistorySyncCounts }
  | { outcome: 'RECOVERED_FROM_INVALID_CURSOR'; counts: GmailHistorySyncCounts }
  /** The main traversal hit `maxPagesPerInvocation` before reaching its final page. Progress was
   *  checkpointed to `gmail_history_sync_progress`; `cursor_value` is untouched (§2.2). The
   *  caller should invoke `syncGmailAccountHistory` again (a later scheduled tick, a retry) to
   *  resume from the checkpoint. */
  | { outcome: 'PARTIAL_PROGRESS'; counts: GmailHistorySyncCounts };

export interface SyncGmailAccountHistoryOptions {
  sourceAccountId: string;
  sourcePolicyId: string;
  /** `gmail_connections.connected_at` -- the lower bound for gap recovery (TDD §12.1:
   *  PRE_CONNECTION_BACKFILL = OFF). */
  connectedAt: string;
  now: string;
  /** Optional per-invocation page budget for the MAIN `history.list` traversal (GPT-PM round-1
   *  MAJOR #1 -- see the module header's design decision #4). `undefined` = unbounded, the
   *  original behavior. Not applied to `recoverFromInvalidCursor`'s bounded gap-recovery window,
   *  which is deliberately not checkpointed. */
  maxPagesPerInvocation?: number;
}

interface SyncProgressRow {
  start_history_id: string;
  prev_cursor_json: string | null;
  next_page_token: string;
  accumulated_newest_internal_date: string;
}

/** Best-effort resumable checkpoint, OUTSIDE the authoritative `cursor_value` (never violates
 *  §2.2). Read once per traversal attempt; the caller MUST verify `start_history_id` and
 *  `prev_cursor_json` still match the CURRENT state before trusting `next_page_token` -- a row
 *  left behind by a superseded traversal (the real cursor moved since this checkpoint was
 *  written) must never be resumed from. */
async function readSyncProgress(
  db: D1Database,
  sourceAccountId: string,
): Promise<SyncProgressRow | null> {
  const row = await db
    .prepare(
      `SELECT start_history_id, prev_cursor_json, next_page_token, accumulated_newest_internal_date
       FROM gmail_history_sync_progress WHERE source_account_id = ?`,
    )
    .bind(sourceAccountId)
    .first<SyncProgressRow>();
  return row ?? null;
}

async function writeSyncProgress(
  db: D1Database,
  sourceAccountId: string,
  progress: {
    startHistoryId: string;
    prevCursorJson: string | null;
    nextPageToken: string;
    accumulatedNewestInternalDate: string;
  },
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO gmail_history_sync_progress
         (source_account_id, start_history_id, prev_cursor_json, next_page_token,
          accumulated_newest_internal_date, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_account_id) DO UPDATE SET
         start_history_id = excluded.start_history_id,
         prev_cursor_json = excluded.prev_cursor_json,
         next_page_token = excluded.next_page_token,
         accumulated_newest_internal_date = excluded.accumulated_newest_internal_date,
         updated_at = excluded.updated_at`,
    )
    .bind(
      sourceAccountId,
      progress.startHistoryId,
      progress.prevCursorJson,
      progress.nextPageToken,
      progress.accumulatedNewestInternalDate,
      now,
    )
    .run();
}

async function deleteSyncProgress(db: D1Database, sourceAccountId: string): Promise<void> {
  await db
    .prepare(`DELETE FROM gmail_history_sync_progress WHERE source_account_id = ?`)
    .bind(sourceAccountId)
    .run();
}

/**
 * Runs steps 1-5 of the crash-safe accept-then-advance protocol to completion, or steps 1-5's own
 * "recover from invalid cursor" branch (step 6) if Gmail reports the current cursor as expired.
 * Nothing is considered durably "done" until the final CAS-advance succeeds -- a crash at any
 * earlier point leaves cursor A untouched, and the next call re-runs the whole traversal, with
 * already-accepted events becoming safe `ALREADY_ACCEPTED` no-ops.
 */
export async function syncGmailAccountHistory(
  db: D1Database,
  historyClient: GmailHistoryClient,
  submitter: GmailEventSubmitter,
  opts: SyncGmailAccountHistoryOptions,
): Promise<SyncGmailAccountHistoryResult> {
  const { cursor, rawJson, malformed } = await readCursor(db, opts.sourceAccountId);
  const ctx: BuildEventContext = {
    sourceAccountId: opts.sourceAccountId,
    sourcePolicyId: opts.sourcePolicyId,
    now: opts.now,
  };
  const counts: GmailHistorySyncCounts = { accepted: 0, alreadyAccepted: 0 };

  // A corrupted/foreign-shaped cursor_value cannot drive a real history.list call -- route it
  // into the SAME bounded-recovery path as an explicit 404 rather than crashing with no
  // self-healing route (a malformed value could otherwise wedge the account forever).
  if (malformed) {
    return recoverFromInvalidCursor(db, historyClient, submitter, opts, rawJson, ctx, counts);
  }

  let startHistoryId: string;
  let baselineLastSeenInternalDate: string;
  if (cursor === null) {
    const conn = await db
      .prepare(`SELECT watch_history_id FROM gmail_connections WHERE source_account_id = ?`)
      .bind(opts.sourceAccountId)
      .first<{ watch_history_id: string | null }>();
    if (conn === null) {
      throw new GmailHistoryCursorMissingBootstrapError(opts.sourceAccountId);
    }
    if (conn.watch_history_id === null) {
      // POLL mode (the default, TDD §12.2/R3) -- and a PUSH-mode account before its first watch
      // call -- never write `watch_history_id`, so there is no durable starting point to resume
      // `history.list` from directly. GPT-PM round-1 BLOCKER (2026-09-13): using a freshly-read
      // `getCurrentHistoryId()` value directly as `startHistoryId` here would silently DROP every
      // message that arrived between `connectedAt` and that read -- `history.list` only returns
      // changes AFTER the given historyId, and by construction that value already reflects
      // anything that happened before it was read. This is the exact same class of bug the
      // recovery path below exists to avoid, so this case is routed through the identical
      // bounded-recovery mechanism (`messages.list`/`messages.get` over
      // `[connectedAt, getCurrentHistoryId())`, with the historyId captured BEFORE enumeration)
      // rather than a direct `history.list` traversal.
      return recoverFromInvalidCursor(db, historyClient, submitter, opts, null, ctx, counts);
    }
    startHistoryId = conn.watch_history_id;
    baselineLastSeenInternalDate = opts.connectedAt;
  } else {
    startHistoryId = cursor.historyId;
    baselineLastSeenInternalDate = cursor.lastSeenInternalDate;
  }

  // GPT-PM round-1 MAJOR #1: resume from a durable page-granularity checkpoint when one exists
  // AND still matches the CURRENT state this call just read -- never trusted blindly, since a
  // checkpoint left behind by a superseded traversal (the real cursor moved since it was written)
  // must not be resumed from.
  const existingProgress = await readSyncProgress(db, opts.sourceAccountId);
  const progressMatchesCurrentState =
    existingProgress !== null &&
    existingProgress.start_history_id === startHistoryId &&
    existingProgress.prev_cursor_json === rawJson;

  let newestInternalDate = progressMatchesCurrentState
    ? existingProgress.accumulated_newest_internal_date
    : baselineLastSeenInternalDate;
  let finalHistoryId: string | null = null;
  let pageToken: string | undefined = progressMatchesCurrentState
    ? existingProgress.next_page_token
    : undefined;
  let pagesProcessedThisInvocation = 0;

  try {
    do {
      const page = await historyClient.listHistory(
        pageToken === undefined ? { startHistoryId } : { startHistoryId, pageToken },
      );
      for (const record of page.records) {
        for (const change of classifyHistoryRecord(record)) {
          const createdAt = await submitChange(historyClient, submitter, change, ctx, counts);
          if (createdAt !== null) newestInternalDate = maxIso(newestInternalDate, createdAt);
        }
      }
      pagesProcessedThisInvocation += 1;
      pageToken = page.nextPageToken;
      if (!pageToken) {
        finalHistoryId = page.historyId;
        break;
      }
      if (
        opts.maxPagesPerInvocation !== undefined &&
        pagesProcessedThisInvocation >= opts.maxPagesPerInvocation
      ) {
        await writeSyncProgress(
          db,
          opts.sourceAccountId,
          {
            startHistoryId,
            prevCursorJson: rawJson,
            nextPageToken: pageToken,
            accumulatedNewestInternalDate: newestInternalDate,
          },
          opts.now,
        );
        return { outcome: 'PARTIAL_PROGRESS', counts };
      }
    } while (pageToken);
  } catch (error) {
    if (!(error instanceof GmailHistoryCursorInvalidError)) throw error;
    await deleteSyncProgress(db, opts.sourceAccountId);
    return recoverFromInvalidCursor(db, historyClient, submitter, opts, rawJson, ctx, counts);
  }

  await deleteSyncProgress(db, opts.sourceAccountId);
  const nextCursor: GmailCursorValue = {
    historyId: finalHistoryId as string,
    lastSeenInternalDate: newestInternalDate,
  };
  const advanced = await advanceCursor(db, opts.sourceAccountId, rawJson, nextCursor, opts.now);
  return advanced ? { outcome: 'SYNCED', counts } : { outcome: 'CAS_LOST_RETRY', counts };
}

/**
 * §2.2 step 6: bounded recovery, re-bootstrapped from `max(connected_at, cursor's last-seen
 * timestamp)` forward via `messages.list`/`messages.get`, never Google's own default full-resync.
 * Every discovered message is classified as `MESSAGE_CREATED` -- recovery cannot distinguish "new
 * to us" from "genuinely just created," and central idempotency (`idempotencyKey()`) makes
 * re-submitting an already-known message a safe no-op.
 */
async function recoverFromInvalidCursor(
  db: D1Database,
  historyClient: GmailHistoryClient,
  submitter: GmailEventSubmitter,
  opts: SyncGmailAccountHistoryOptions,
  prevRawJson: string | null,
  ctx: BuildEventContext,
  counts: GmailHistorySyncCounts,
): Promise<SyncGmailAccountHistoryResult> {
  const prevCursor = prevRawJson === null ? null : tryParseCursor(prevRawJson);
  const windowStart = maxIso(
    opts.connectedAt,
    prevCursor?.lastSeenInternalDate ?? opts.connectedAt,
  );

  // Captured BEFORE enumeration begins: a message that arrives while recovery is still listing
  // must not be silently claimed as "covered" by this recovery's cursor advance -- it will be
  // picked up by the next normal history.list sync starting from this historyId instead.
  const recoveryHistoryId = await historyClient.getCurrentHistoryId();

  let newestInternalDate = windowStart;
  const seen = new Set<string>();
  let pageToken: string | undefined;

  do {
    const page = await historyClient.listMessagesInWindow(
      pageToken === undefined ? { afterIso: windowStart } : { afterIso: windowStart, pageToken },
    );
    for (const ref of page.messages) {
      if (seen.has(ref.messageId)) continue;
      seen.add(ref.messageId);
      const change: PendingChange = {
        changeKind: 'MESSAGE_ADDED',
        messageId: ref.messageId,
        threadId: ref.threadId,
      };
      const createdAt = await submitChange(historyClient, submitter, change, ctx, counts);
      if (createdAt !== null) newestInternalDate = maxIso(newestInternalDate, createdAt);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  const nextCursor: GmailCursorValue = {
    historyId: recoveryHistoryId,
    lastSeenInternalDate: newestInternalDate,
  };
  const advanced = await advanceCursor(db, opts.sourceAccountId, prevRawJson, nextCursor, opts.now);
  return advanced
    ? { outcome: 'RECOVERED_FROM_INVALID_CURSOR', counts }
    : { outcome: 'CAS_LOST_RETRY', counts };
}
