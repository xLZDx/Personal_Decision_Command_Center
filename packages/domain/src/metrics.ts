import type { D1Database } from '@cloudflare/workers-types';

export interface OldestUnprocessedEvent {
  eventId: string;
  receivedAt: string;
  ageMs: number;
}

/**
 * TDD §71 Queue/Reliability DoD: "oldest accepted-unprocessed metric exists". An event counts as
 * accepted-unprocessed while it is anywhere short of a TERMINAL outcome -- `ACCEPTED`, `PROCESSING`,
 * and `RETRYABLE_FAILED` all still owe a result; `PROCESSED` and `DLQ` are both resolutions (a
 * dead-lettered event is visible and actionable through the DLQ count itself, not through this
 * age metric -- conflating the two would hide a genuinely stuck pipeline behind an old-but-DLQ'd
 * event that OPS already knows about).
 *
 * Returns `null` when nothing is outstanding -- an empty backlog is not an error condition.
 */
export async function getOldestUnprocessedEvent(
  db: D1Database,
  opts: { now: string },
): Promise<OldestUnprocessedEvent | null> {
  const row = await db
    .prepare(
      `SELECT event_id, received_at FROM ingest_events
       WHERE state IN ('ACCEPTED', 'PROCESSING', 'RETRYABLE_FAILED')
       ORDER BY received_at ASC
       LIMIT 1`,
    )
    .first<{ event_id: string; received_at: string }>();
  if (!row) return null;

  return {
    eventId: row.event_id,
    receivedAt: row.received_at,
    ageMs: Date.parse(opts.now) - Date.parse(row.received_at),
  };
}
