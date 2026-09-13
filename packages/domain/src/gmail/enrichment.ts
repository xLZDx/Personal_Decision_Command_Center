import type { D1Database } from '@cloudflare/workers-types';

import { isUniqueConstraintError } from '../errors.js';

/**
 * `gmail_source_enrichments` (proposal §2.4, GPT-PM round-3 BLOCKER): the AI-extraction pipeline's
 * durable, idempotent result. A `MESSAGE_DELETED` event completes via the explicit
 * `NO_CONTENT_DELETED` marker with zero Gmail API calls and zero AI invocation -- the discriminated
 * union below makes that the type system's own guarantee (mirrors migration 0002's own
 * `CHECK ((status = 'NO_CONTENT_DELETED') = (summary IS NULL AND extracted_json IS NULL AND
 * model_id IS NULL))`), not something a caller could get wrong by passing mismatched nulls.
 */
export type EnrichmentInput =
  | { status: 'COMPLETE'; summary: string; extractedJson: string; modelId: string }
  | { status: 'NO_CONTENT_DELETED' };

export interface PersistEnrichmentOptions {
  eventId: string;
  /** The exact lease token this attempt currently holds (`ClaimedEvent.leaseToken`). */
  leaseToken: string;
  now: string;
  input: EnrichmentInput;
}

export type PersistEnrichmentResult =
  { outcome: 'PERSISTED' } | { outcome: 'LEASE_LOST' } | { outcome: 'ALREADY_PERSISTED' };

/**
 * The lease-fenced write that closes GPT-PM's round-3 BLOCKER on the G3 gate review: a stale
 * claimant that has already lost its processing lease must not be able to author the canonical
 * enrichment result. `INSERT ... SELECT ... WHERE EXISTS (...)` is the mechanism -- when the fence
 * condition (`ingest_events.state = 'PROCESSING' AND processing_lease_token = <this token>`) does
 * not hold, the SELECT yields zero rows and the INSERT inserts nothing (no error, `changes === 0`,
 * mapped to `LEASE_LOST`) -- exactly the same "zero rows, not an exception" ABA protection
 * `packages/domain/src/transitions.ts`'s fenced UPDATEs already rely on for G2's own terminal
 * mutations.
 *
 * A caller is expected to run the step-0 idempotency check (`getEnrichment`) before calling this --
 * see proposal §2.4 -- but `ALREADY_PERSISTED` is still handled gracefully here (via
 * `isUniqueConstraintError`, the same pattern `ingest.ts`'s own idempotent insert uses) rather than
 * thrown, so a caller that races step 0 against a concurrent attempt under the SAME valid lease
 * (impossible under normal G2 fencing, since only one attempt ever holds a given token, but cheap
 * defense-in-depth) gets a clean outcome instead of an unhandled rejection.
 */
export async function persistEnrichment(
  db: D1Database,
  opts: PersistEnrichmentOptions,
): Promise<PersistEnrichmentResult> {
  const status = opts.input.status;
  const summary = opts.input.status === 'COMPLETE' ? opts.input.summary : null;
  const extractedJson = opts.input.status === 'COMPLETE' ? opts.input.extractedJson : null;
  const modelId = opts.input.status === 'COMPLETE' ? opts.input.modelId : null;

  try {
    const result = await db
      .prepare(
        `INSERT INTO gmail_source_enrichments (event_id, status, summary, extracted_json, model_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM ingest_events WHERE event_id = ? AND state = 'PROCESSING' AND processing_lease_token = ?
         )`,
      )
      .bind(
        opts.eventId,
        status,
        summary,
        extractedJson,
        modelId,
        opts.now,
        opts.eventId,
        opts.leaseToken,
      )
      .run();
    return result.meta.changes === 1 ? { outcome: 'PERSISTED' } : { outcome: 'LEASE_LOST' };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    return { outcome: 'ALREADY_PERSISTED' };
  }
}

export interface Enrichment {
  eventId: string;
  status: 'COMPLETE' | 'NO_CONTENT_DELETED';
  summary: string | null;
  extractedJson: string | null;
  modelId: string | null;
}

/**
 * The step-0 idempotency check (proposal §2.4): if a row already exists for this `event_id`, a
 * retried processing attempt skips straight to completion using the already-persisted result
 * rather than calling the AI provider again. Returns `null` when nothing has been persisted yet --
 * the processor must then run the real fetch/AI/persist pipeline.
 */
export async function getEnrichment(db: D1Database, eventId: string): Promise<Enrichment | null> {
  const row = await db
    .prepare(
      `SELECT event_id, status, summary, extracted_json, model_id
       FROM gmail_source_enrichments WHERE event_id = ?`,
    )
    .bind(eventId)
    .first<{
      event_id: string;
      status: 'COMPLETE' | 'NO_CONTENT_DELETED';
      summary: string | null;
      extracted_json: string | null;
      model_id: string | null;
    }>();
  if (row === null) return null;
  return {
    eventId: row.event_id,
    status: row.status,
    summary: row.summary,
    extractedJson: row.extracted_json,
    modelId: row.model_id,
  };
}
