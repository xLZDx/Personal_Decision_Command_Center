-- Migration 0006: G3 checkpoint 5, GPT-PM round-1 MAJOR (verified against Cloudflare's current
-- Workers Free plan documentation, updated 2026-09-05: 50 subrequests/invocation ceiling,
-- confirmed unchanged by the Feb-2026 change notice). syncGmailAccountHistory's main §2.2
-- traversal previously had no bound on page/record count per invocation and recorded NO progress
-- until the whole traversal reached its final page -- a legitimate backlog of roughly 50+ new
-- messages (one messages.get subrequest each, on top of history.list itself) can exceed the
-- platform ceiling before ever reaching that final page, wedging the account: cursor_value stays
-- untouched (correct, by design -- §2.2 forbids advancing it mid-traversal), so every retry
-- re-attempts the identical doomed traversal from page 1 with zero durable progress.
--
-- Fix: a resumable, best-effort, NON-authoritative checkpoint held OUTSIDE cursor_value. Holds
-- the in-progress traversal's own anchor (start_history_id) and fencing token
-- (prev_cursor_json -- the exact source_cursors.cursor_value this traversal is running against)
-- alongside its resume point (next_page_token) and running newest-internal-date. Read once at the
-- start of a traversal and honored ONLY when both anchor fields still match the CURRENT state
-- actually read from source_cursors this call (never trusted blindly) -- a stale or foreign
-- checkpoint (another invocation already advanced/reset the real cursor since this checkpoint was
-- written) is discarded and the traversal restarts from page 1 against the fresh state, never
-- resumed against stale assumptions. Deleted on every terminal outcome of the main traversal
-- (successful CAS-advance, CAS-loss, or a transition into 404/invalid-cursor recovery) so it can
-- never outlive the traversal it describes. Deliberately scoped to the MAIN history.list
-- traversal only -- the narrower 404/invalid-cursor recovery path (recoverFromInvalidCursor) is
-- NOT checkpointed by this table; see history-sync.ts's module header for why that residual gap
-- is accepted rather than closed here.
CREATE TABLE gmail_history_sync_progress (
  source_account_id TEXT PRIMARY KEY REFERENCES gmail_connections (source_account_id),
  start_history_id TEXT NOT NULL,
  prev_cursor_json TEXT,
  next_page_token TEXT NOT NULL,
  accumulated_newest_internal_date TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
