-- Migration 0008: G3 checkpoint 5, GPT-PM round-2 findings #1 and #2 (2026-09-13).
--
-- Finding #1: migration 0006's checkpoint was PAGE-granularity, but Gmail's `history.list`
-- documents returning up to 100 history records per page, and each MESSAGE_ADDED costs 2 external
-- subrequests (`messages.get` + the ingest submit) against Cloudflare Workers Free's 50/invocation
-- ceiling -- a single page containing 50+ created-message changes can exhaust the ceiling BEFORE
-- ever reaching the page-boundary budget check, reproducing the exact liveness failure the
-- checkpoint mechanism exists to prevent. Fix: `next_change_index` records how many of the
-- CURRENT page's classified changes (flattened, in processing order) have already been durably
-- submitted, so a resumed invocation re-fetches the SAME page (`next_page_token` now names the
-- page to (re)fetch, not necessarily the next one) and skips straight to `next_change_index`.
--
-- GPT-PM's own words: "The recovery path therefore needs the same effective bounded-progress
-- property, although it need not use the identical table/schema if a simpler safe mechanism
-- works." This migration extends the SAME table to also checkpoint `recoverFromInvalidCursor`'s
-- bounded gap-recovery enumeration (`mode = 'RECOVERY'`), reusing `next_page_token`/
-- `next_change_index`/`accumulated_newest_internal_date` with recovery's own anchor
-- (`window_start` instead of `start_history_id`) and its own extra durable field
-- (`recovery_history_id`, captured once before enumeration begins and must survive across
-- resuming invocations unchanged).
--
-- Finding #2: `writeSyncProgress`/`deleteSyncProgress` (migration 0006) were UNCONDITIONAL --
-- keyed only by `source_account_id` -- so a traversal that stalls and resumes late could silently
-- overwrite or delete a DIFFERENT, newer traversal's valid checkpoint (e.g. after the authoritative
-- cursor advanced and a fresh traversal already checkpointed its own progress against the new
-- state). Fix: every write/delete is now fenced by a `WHERE` predicate on the row's OWN anchor
-- (`(mode, start_history_id, prev_cursor_json)` for MAIN, `(mode, window_start, prev_cursor_json)`
-- for RECOVERY) -- the same CAS convention `advanceCursor`/`source_cursors` already uses: a stale
-- caller's mutation naturally affects zero rows because the row's anchor no longer matches what
-- that caller expects, rather than being applied unconditionally.
--
-- SQLite/D1 cannot relax migration 0006's `start_history_id TEXT NOT NULL` (needed nullable for
-- RECOVERY-mode rows, which anchor on `window_start` instead) via a plain `ALTER TABLE ADD COLUMN`
-- -- this migration rebuilds the table. Migration 0006's own file is left untouched, per this
-- project's append-only migration convention; this is a new migration, not an edit of a committed
-- one. Nothing has been deployed against migration 0006's shape outside this repo's own test
-- fixtures, so the rebuild is a plain DROP + CREATE, not a copy-preserving migration.
DROP TABLE gmail_history_sync_progress;
CREATE TABLE gmail_history_sync_progress (
  source_account_id TEXT PRIMARY KEY REFERENCES gmail_connections (source_account_id),
  mode TEXT NOT NULL CHECK (mode IN ('MAIN', 'RECOVERY')),
  -- MAIN mode's anchor -- the history.list traversal this checkpoint belongs to. NULL for a
  -- RECOVERY-mode row.
  start_history_id TEXT,
  -- RECOVERY mode's anchor -- the messages.list gap-recovery window this checkpoint belongs to.
  -- NULL for a MAIN-mode row.
  window_start TEXT,
  -- Both modes: the exact source_cursors.cursor_value this traversal/recovery observed at its own
  -- start. Part of the fencing predicate on every write/delete (see above).
  prev_cursor_json TEXT,
  -- RECOVERY mode only: historyId captured BEFORE enumeration began -- must survive unchanged
  -- across resuming invocations, since it becomes the final cursor's historyId once recovery
  -- completes. NULL for a MAIN-mode row (the main traversal's final historyId instead comes from
  -- the last page's own `historyId` field, discovered only once that page is reached).
  recovery_history_id TEXT,
  -- The token to pass on the NEXT listHistory/listMessagesInWindow call to (re)fetch the page
  -- currently being resumed -- NULL means "fetch the first page" (startHistoryId/windowStart
  -- alone, no pageToken).
  next_page_token TEXT,
  next_change_index INTEGER NOT NULL DEFAULT 0,
  accumulated_newest_internal_date TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
