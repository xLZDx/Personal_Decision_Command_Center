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
 *    GPT-PM round-1 MAJOR, resolved round-2 (2026-09-13, ruling option (b)): flagged this as a real
 *    violation of `NormalizedEvent`'s own provenance split (`occurred_at` = provider time,
 *    `received_at` = transport time, `packages/contracts/src/event.ts`) -- not merely an
 *    approximation, because a downstream latency/ordering consumer could not distinguish "this
 *    really happened now" from "we don't know when this happened." Fixed via the contract's new
 *    additive `occurred_at_quality` field (`'PROVIDER_REPORTED'` | `'ESTIMATED_FROM_RECEIPT'`,
 *    default `'PROVIDER_REPORTED'` so every OTHER existing producer/consumer is unaffected): these
 *    two event types now set `'ESTIMATED_FROM_RECEIPT'` explicitly, persisted end-to-end through
 *    `ingest_events.occurred_at_quality` (migration 0007) -- see ADR-004 and
 *    `core/DECISION_LOG.md`.
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
 * 4. Per-invocation work is BOUNDED at CHANGE granularity (not just page granularity -- fixed
 *    2026-09-13, GPT-PM round-1 MAJOR then round-2 MAJOR). Cloudflare's own current documentation
 *    gives Workers Free 50 subrequests/invocation, a real and current ceiling, and every
 *    `MESSAGE_ADDED` costs 2 external subrequests (`messages.get` + the ingest submit; every other
 *    change kind costs 1, submit only). Round-1's remediation checkpointed only at PAGE boundaries,
 *    but Gmail documents `history.list` as returning up to 100 records per page -- a single page
 *    can exceed the ceiling before ever reaching a page boundary. `next_change_index` now tracks
 *    progress WITHIN a page (its classified changes, flattened across records, in processing
 *    order), so a resumed invocation re-fetches the SAME page and skips straight to where it left
 *    off instead of restarting the page or the whole traversal.
 *
 *    `SyncGmailAccountHistoryOptions.maxExternalCallsPerInvocation` (optional; `undefined` =
 *    unbounded -- every test that omits it is intentionally exercising unbounded behavior;
 *    `RECOMMENDED_MAX_EXTERNAL_CALLS_PER_INVOCATION` is exported as the safe default a real Worker
 *    caller should pass on the Free plan) caps external calls per invocation. When the budget would
 *    be exceeded, progress is durably checkpointed in `gmail_history_sync_progress` -- a table
 *    OUTSIDE `cursor_value`, so this does not violate §2.2 (which forbids advancing the
 *    AUTHORITATIVE cursor mid-traversal, not persisting other resume state) -- and the call returns
 *    `PARTIAL_PROGRESS`; the next invocation resumes from the checkpoint, fenced against the
 *    CURRENT `source_cursors` state read at the START of that call (a stale/foreign checkpoint is
 *    discarded, never resumed against assumptions that no longer hold).
 *
 *    GPT-PM round-2 MAJOR: the checkpoint mechanism now ALSO covers `recoverFromInvalidCursor`'s
 *    bounded `messages.list` gap-recovery enumeration (`mode = 'RECOVERY'` in the same table,
 *    anchored on `window_start` instead of `start_history_id`) -- round-1's "the recovery window is
 *    bounded by the size of one gap, so it doesn't need this" framing was rejected: a finite gap can
 *    still contain more messages than one invocation's external-call budget, and the round-1
 *    BLOCKER fix made the first-ever POLL bootstrap deliberately route through this exact path, so
 *    it is now load-bearing, not a rare edge case.
 *
 *    GPT-PM round-2 MAJOR (checkpoint mutation fencing): round-1's `writeSyncProgress`/
 *    `deleteSyncProgress` were unconditional (keyed only by `source_account_id`), so a stalled older
 *    traversal resuming late could silently clobber or delete a DIFFERENT, newer traversal's valid
 *    checkpoint. Every write/delete is now fenced by a `WHERE` predicate on the row's own anchor
 *    (mode + start_history_id/window_start + prev_cursor_json) -- the same CAS convention
 *    `advanceCursor` already uses for `source_cursors`: a stale caller's mutation naturally affects
 *    zero rows because the row's anchor no longer matches what that caller expects.
 *
 *    GPT-PM round-3 (FINAL, 2026-09-13) found this fencing incomplete and gate-ruled it ACCEPTED
 *    RESIDUAL RISK / mandatory follow-up backlog (not a blocker for this checkpoint, under the
 *    operator's hard 3-round cap -- "checkpoint 5 closes after this Round 3... No Round 4"), TWO
 *    real gaps, both left UNFIXED here, deliberately, for a future gate to close:
 *
 *    (a) **Same-anchor concurrent-traversal race can permanently block checkpointing, not just
 *    duplicate work.** `writeMainProgress`/`writeRecoveryProgress` fence an UPDATE against an
 *    EXISTING conflicting row's anchor, but a plain INSERT (no existing row) is unconditional --
 *    it never re-checks that `source_cursors.cursor_value` still equals the anchor the WRITER
 *    itself observed at its own start. Concretely: T1 and T2 both read cursor A; T2 finishes first,
 *    deletes its own (possibly nonexistent) A-checkpoint, and CAS-advances A->B; T1, still running
 *    under stale anchor A, later hits its budget and writes an A-anchored checkpoint into the now-
 *    EMPTY table -- nothing stopped that INSERT, because nothing there checks cursor_value at
 *    write time. Every subsequent legitimate B-anchored write (from a fresh T3 reading the CURRENT
 *    cursor B) is then fenced OUT by this stale A row's mismatched anchor, and both `writeMainProgress`
 *    /`writeRecoveryProgress`'s own boolean "did this actually write" return value is silently
 *    IGNORED by both call sites, which unconditionally return `PARTIAL_PROGRESS` either way -- so a
 *    permanently-orphaned stale row can silently block this account's checkpointing forever, not
 *    merely cause redundant idempotent resubmission as round-1/round-2's own "accepted, only
 *    inefficient" framing assumed. Real fix needs either an authoritative-cursor-fenced INSERT (not
 *    just the UPDATE branch) or a genuine per-traversal generation/invocation token, plus actually
 *    acting on write*Progress()'s return value (at minimum: don't report `PARTIAL_PROGRESS` when a
 *    write silently failed -- re-read state and report a CAS-loss-shaped outcome instead).
 *
 *    (b) **The external-call budget is opt-in, not a real ceiling, even when set.**
 *    `maxExternalCallsPerInvocation` defaults to `undefined` (unbounded) rather than defaulting to
 *    `RECOMMENDED_MAX_EXTERNAL_CALLS_PER_INVOCATION` -- a caller that simply omits the option gets
 *    the exact unbounded liveness exposure this whole mechanism exists to eliminate. And even when
 *    set, the budget is only checked BEFORE processing each individual change, never before the
 *    `listHistory`/`listMessagesInWindow` PAGE FETCH itself that starts a new page -- a page whose
 *    own fetch happens to land exactly at the budget boundary is still fetched (its cost accounted
 *    for only AFTER the fact), so the option is not a strict ceiling. Real fix: default to the
 *    recommended constant unless a caller explicitly opts into unbounded (e.g. `Infinity`, a named
 *    mode), and reserve/check budget before every external call, page/window fetches included.
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

/** External-call cost of processing one change (GPT-PM round-2 MAJOR): `MESSAGE_ADDED` needs a
 *  `messages.get` on top of the submit itself; every other kind only submits. Used to enforce
 *  `maxExternalCallsPerInvocation` at CHANGE granularity, not merely page granularity. */
function changeCost(change: PendingChange): number {
  return change.changeKind === 'MESSAGE_ADDED' ? 2 : 1;
}

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
        occurred_at_quality: 'PROVIDER_REPORTED',
        source_version: null,
      });
    }
    case 'MESSAGE_DELETED':
      return NormalizedEventSchema.parse({
        ...base,
        event_type: 'MESSAGE_DELETED',
        direction: 'INBOUND',
        occurred_at: ctx.now,
        occurred_at_quality: 'ESTIMATED_FROM_RECEIPT',
        source_version: null,
      });
    case 'LABEL_ADDED':
      return NormalizedEventSchema.parse({
        ...base,
        event_type: 'MESSAGE_UPDATED',
        direction: 'INBOUND',
        occurred_at: ctx.now,
        occurred_at_quality: 'ESTIMATED_FROM_RECEIPT',
        source_version: `${change.historyRecordId}:LABEL_ADDED`,
      });
    case 'LABEL_REMOVED':
      return NormalizedEventSchema.parse({
        ...base,
        event_type: 'MESSAGE_UPDATED',
        direction: 'INBOUND',
        occurred_at: ctx.now,
        occurred_at_quality: 'ESTIMATED_FROM_RECEIPT',
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
// Resumable checkpoint (`gmail_history_sync_progress`, migration 0008) -- OUTSIDE the
// authoritative `cursor_value`, never violates §2.2. Covers BOTH the main `history.list`
// traversal (`mode: 'MAIN'`) and `recoverFromInvalidCursor`'s bounded gap-recovery enumeration
// (`mode: 'RECOVERY'`), GPT-PM round-2 MAJOR.
// ---------------------------------------------------------------------------------------------

/** A safe default for a real Worker caller targeting Cloudflare Workers Free (50 external
 *  subrequests/invocation) -- leaves headroom for the page/window fetch itself plus a reasonable
 *  safety margin, per GPT-PM round-2's "encode a safe domain default" option.
 *  `maxExternalCallsPerInvocation` stays optional rather than mandatory so tests (and any future
 *  non-Free-tier caller) can still exercise genuinely unbounded behavior deliberately. */
export const RECOMMENDED_MAX_EXTERNAL_CALLS_PER_INVOCATION = 40;

interface SyncProgressRow {
  mode: 'MAIN' | 'RECOVERY';
  start_history_id: string | null;
  window_start: string | null;
  prev_cursor_json: string | null;
  recovery_history_id: string | null;
  next_page_token: string | null;
  next_change_index: number;
  accumulated_newest_internal_date: string;
}

async function readSyncProgress(
  db: D1Database,
  sourceAccountId: string,
): Promise<SyncProgressRow | null> {
  const row = await db
    .prepare(
      `SELECT mode, start_history_id, window_start, prev_cursor_json, recovery_history_id,
              next_page_token, next_change_index, accumulated_newest_internal_date
       FROM gmail_history_sync_progress WHERE source_account_id = ?`,
    )
    .bind(sourceAccountId)
    .first<SyncProgressRow>();
  return row ?? null;
}

/**
 * Fenced write for a MAIN-mode checkpoint (GPT-PM round-2 MAJOR): the `ON CONFLICT ... WHERE`
 * predicate only allows overwriting an EXISTING row that already belongs to THIS SAME traversal
 * (`mode = 'MAIN'` and a matching anchor) -- a stale caller from a superseded traversal naturally
 * writes zero rows instead of clobbering a different, newer checkpoint, the same CAS convention
 * `advanceCursor` already uses for `source_cursors`. No existing row at all is always safe to
 * INSERT (nothing to clobber), exactly like `advanceCursor`'s own "no row yet" case.
 */
async function writeMainProgress(
  db: D1Database,
  sourceAccountId: string,
  progress: {
    startHistoryId: string;
    prevCursorJson: string | null;
    nextPageToken: string | undefined;
    nextChangeIndex: number;
    accumulatedNewestInternalDate: string;
  },
  now: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO gmail_history_sync_progress
         (source_account_id, mode, start_history_id, window_start, prev_cursor_json,
          recovery_history_id, next_page_token, next_change_index,
          accumulated_newest_internal_date, updated_at)
       VALUES (?, 'MAIN', ?, NULL, ?, NULL, ?, ?, ?, ?)
       ON CONFLICT (source_account_id) DO UPDATE SET
         mode = 'MAIN',
         start_history_id = excluded.start_history_id,
         window_start = NULL,
         prev_cursor_json = excluded.prev_cursor_json,
         recovery_history_id = NULL,
         next_page_token = excluded.next_page_token,
         next_change_index = excluded.next_change_index,
         accumulated_newest_internal_date = excluded.accumulated_newest_internal_date,
         updated_at = excluded.updated_at
       WHERE gmail_history_sync_progress.mode = 'MAIN'
         AND gmail_history_sync_progress.start_history_id IS ?
         AND gmail_history_sync_progress.prev_cursor_json IS ?`,
    )
    .bind(
      sourceAccountId,
      progress.startHistoryId,
      progress.prevCursorJson,
      progress.nextPageToken ?? null,
      progress.nextChangeIndex,
      progress.accumulatedNewestInternalDate,
      now,
      progress.startHistoryId,
      progress.prevCursorJson,
    )
    .run();
  return result.meta.changes === 1;
}

/** Fenced delete for a MAIN-mode checkpoint -- same anchor predicate as `writeMainProgress`, so a
 *  stale traversal's cleanup cannot delete a different, newer checkpoint. */
async function deleteMainProgress(
  db: D1Database,
  sourceAccountId: string,
  startHistoryId: string,
  prevCursorJson: string | null,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM gmail_history_sync_progress
       WHERE source_account_id = ? AND mode = 'MAIN'
         AND start_history_id IS ? AND prev_cursor_json IS ?`,
    )
    .bind(sourceAccountId, startHistoryId, prevCursorJson)
    .run();
}

/** RECOVERY-mode equivalent of `writeMainProgress` -- anchored on `window_start` instead of
 *  `start_history_id`, and additionally persists `recovery_history_id` (captured once, before
 *  enumeration began, and never re-derived on resume -- see the module header). */
async function writeRecoveryProgress(
  db: D1Database,
  sourceAccountId: string,
  progress: {
    windowStart: string;
    prevCursorJson: string | null;
    recoveryHistoryId: string;
    nextPageToken: string | undefined;
    nextChangeIndex: number;
    accumulatedNewestInternalDate: string;
  },
  now: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO gmail_history_sync_progress
         (source_account_id, mode, start_history_id, window_start, prev_cursor_json,
          recovery_history_id, next_page_token, next_change_index,
          accumulated_newest_internal_date, updated_at)
       VALUES (?, 'RECOVERY', NULL, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_account_id) DO UPDATE SET
         mode = 'RECOVERY',
         start_history_id = NULL,
         window_start = excluded.window_start,
         prev_cursor_json = excluded.prev_cursor_json,
         recovery_history_id = excluded.recovery_history_id,
         next_page_token = excluded.next_page_token,
         next_change_index = excluded.next_change_index,
         accumulated_newest_internal_date = excluded.accumulated_newest_internal_date,
         updated_at = excluded.updated_at
       WHERE gmail_history_sync_progress.mode = 'RECOVERY'
         AND gmail_history_sync_progress.window_start IS ?
         AND gmail_history_sync_progress.prev_cursor_json IS ?`,
    )
    .bind(
      sourceAccountId,
      progress.windowStart,
      progress.prevCursorJson,
      progress.recoveryHistoryId,
      progress.nextPageToken ?? null,
      progress.nextChangeIndex,
      progress.accumulatedNewestInternalDate,
      now,
      progress.windowStart,
      progress.prevCursorJson,
    )
    .run();
  return result.meta.changes === 1;
}

/** RECOVERY-mode equivalent of `deleteMainProgress`. */
async function deleteRecoveryProgress(
  db: D1Database,
  sourceAccountId: string,
  windowStart: string,
  prevCursorJson: string | null,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM gmail_history_sync_progress
       WHERE source_account_id = ? AND mode = 'RECOVERY'
         AND window_start IS ? AND prev_cursor_json IS ?`,
    )
    .bind(sourceAccountId, windowStart, prevCursorJson)
    .run();
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
  /** Either the main traversal or gap recovery hit `maxExternalCallsPerInvocation` before
   *  finishing. Progress was checkpointed to `gmail_history_sync_progress`; `cursor_value` is
   *  untouched (§2.2). The caller should invoke `syncGmailAccountHistory` again (a later
   *  scheduled tick, a retry) to resume from the checkpoint. */
  | { outcome: 'PARTIAL_PROGRESS'; counts: GmailHistorySyncCounts };

export interface SyncGmailAccountHistoryOptions {
  sourceAccountId: string;
  sourcePolicyId: string;
  /** `gmail_connections.connected_at` -- the lower bound for gap recovery (TDD §12.1:
   *  PRE_CONNECTION_BACKFILL = OFF). */
  connectedAt: string;
  now: string;
  /** Optional per-invocation external-call budget, applied at CHANGE granularity to BOTH the main
   *  traversal and gap recovery (GPT-PM round-1/round-2 MAJOR -- see the module header's design
   *  decision #4). `undefined` = unbounded, the original behavior. See
   *  `RECOMMENDED_MAX_EXTERNAL_CALLS_PER_INVOCATION` for a safe Free-plan default. */
  maxExternalCallsPerInvocation?: number;
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

  // Resume from a durable checkpoint when one exists AND still matches the CURRENT state this
  // call just read -- never trusted blindly (see writeMainProgress's own fencing doc comment).
  const existingProgress = await readSyncProgress(db, opts.sourceAccountId);
  const mainProgressMatches =
    existingProgress !== null &&
    existingProgress.mode === 'MAIN' &&
    existingProgress.start_history_id === startHistoryId &&
    existingProgress.prev_cursor_json === rawJson;

  let newestInternalDate = mainProgressMatches
    ? existingProgress.accumulated_newest_internal_date
    : baselineLastSeenInternalDate;
  let finalHistoryId: string | null = null;
  let pageToken: string | undefined = mainProgressMatches
    ? (existingProgress.next_page_token ?? undefined)
    : undefined;
  let resumeChangeIndex = mainProgressMatches ? existingProgress.next_change_index : 0;
  let externalCallsThisInvocation = 0;

  try {
    do {
      const page = await historyClient.listHistory(
        pageToken === undefined ? { startHistoryId } : { startHistoryId, pageToken },
      );
      externalCallsThisInvocation += 1; // the page fetch itself

      const changes = page.records.flatMap(classifyHistoryRecord);
      for (const [offset, change] of changes.slice(resumeChangeIndex).entries()) {
        const i = resumeChangeIndex + offset;
        const cost = changeCost(change);
        if (
          opts.maxExternalCallsPerInvocation !== undefined &&
          externalCallsThisInvocation + cost > opts.maxExternalCallsPerInvocation
        ) {
          await writeMainProgress(
            db,
            opts.sourceAccountId,
            {
              startHistoryId,
              prevCursorJson: rawJson,
              nextPageToken: pageToken, // re-fetch the SAME (partially-processed) page
              nextChangeIndex: i,
              accumulatedNewestInternalDate: newestInternalDate,
            },
            opts.now,
          );
          return { outcome: 'PARTIAL_PROGRESS', counts };
        }
        const createdAt = await submitChange(historyClient, submitter, change, ctx, counts);
        externalCallsThisInvocation += cost;
        if (createdAt !== null) newestInternalDate = maxIso(newestInternalDate, createdAt);
      }
      resumeChangeIndex = 0;
      pageToken = page.nextPageToken;
      if (!pageToken) {
        finalHistoryId = page.historyId;
        break;
      }
    } while (pageToken);
  } catch (error) {
    if (!(error instanceof GmailHistoryCursorInvalidError)) throw error;
    await deleteMainProgress(db, opts.sourceAccountId, startHistoryId, rawJson);
    return recoverFromInvalidCursor(db, historyClient, submitter, opts, rawJson, ctx, counts);
  }

  await deleteMainProgress(db, opts.sourceAccountId, startHistoryId, rawJson);
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

  const existingProgress = await readSyncProgress(db, opts.sourceAccountId);
  const recoveryProgressMatches =
    existingProgress !== null &&
    existingProgress.mode === 'RECOVERY' &&
    existingProgress.window_start === windowStart &&
    existingProgress.prev_cursor_json === prevRawJson;

  // Captured BEFORE enumeration begins on a FRESH recovery attempt -- a RESUMED recovery reuses
  // the SAME historyId a prior invocation already captured (never re-derives a later one), or the
  // recovered cursor could claim coverage past messages that arrived mid-recovery.
  const recoveryHistoryId = recoveryProgressMatches
    ? (existingProgress.recovery_history_id as string)
    : await historyClient.getCurrentHistoryId();

  let newestInternalDate = recoveryProgressMatches
    ? existingProgress.accumulated_newest_internal_date
    : windowStart;
  let pageToken: string | undefined = recoveryProgressMatches
    ? (existingProgress.next_page_token ?? undefined)
    : undefined;
  let resumeMessageIndex = recoveryProgressMatches ? existingProgress.next_change_index : 0;
  let externalCallsThisInvocation = 0;
  const seen = new Set<string>();

  do {
    const page = await historyClient.listMessagesInWindow(
      pageToken === undefined ? { afterIso: windowStart } : { afterIso: windowStart, pageToken },
    );
    externalCallsThisInvocation += 1; // the window-page fetch itself

    for (const [offset, ref] of page.messages.slice(resumeMessageIndex).entries()) {
      const i = resumeMessageIndex + offset;
      if (seen.has(ref.messageId)) continue;

      const change: PendingChange = {
        changeKind: 'MESSAGE_ADDED',
        messageId: ref.messageId,
        threadId: ref.threadId,
      };
      const cost = changeCost(change);
      if (
        opts.maxExternalCallsPerInvocation !== undefined &&
        externalCallsThisInvocation + cost > opts.maxExternalCallsPerInvocation
      ) {
        await writeRecoveryProgress(
          db,
          opts.sourceAccountId,
          {
            windowStart,
            prevCursorJson: prevRawJson,
            recoveryHistoryId,
            nextPageToken: pageToken,
            nextChangeIndex: i,
            accumulatedNewestInternalDate: newestInternalDate,
          },
          opts.now,
        );
        return { outcome: 'PARTIAL_PROGRESS', counts };
      }

      seen.add(ref.messageId);
      const createdAt = await submitChange(historyClient, submitter, change, ctx, counts);
      externalCallsThisInvocation += cost;
      if (createdAt !== null) newestInternalDate = maxIso(newestInternalDate, createdAt);
    }
    resumeMessageIndex = 0;
    pageToken = page.nextPageToken;
  } while (pageToken);

  await deleteRecoveryProgress(db, opts.sourceAccountId, windowStart, prevRawJson);
  const nextCursor: GmailCursorValue = {
    historyId: recoveryHistoryId,
    lastSeenInternalDate: newestInternalDate,
  };
  const advanced = await advanceCursor(db, opts.sourceAccountId, prevRawJson, nextCursor, opts.now);
  return advanced
    ? { outcome: 'RECOVERED_FROM_INVALID_CURSOR', counts }
    : { outcome: 'CAS_LOST_RETRY', counts };
}
