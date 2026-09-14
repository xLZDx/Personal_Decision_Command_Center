import { getEnrichment, persistEnrichment } from '@pdos/domain';
import type { D1Database } from '@cloudflare/workers-types';
import type { GmailAIEngine, GmailAIEnrichmentResult } from '@pdos/policy';

import type { EventProcessor, ProcessOutcome } from './processor.js';

export interface GmailEventProcessorOptions {
  db: D1Database;
  engine: Pick<GmailAIEngine, 'enrich'>;
  now?: () => string;
  compatibilityMode?: boolean;
}

/**
 * Connects the source-local Gmail AI boundary to G2's lease lifecycle. The persisted enrichment
 * row is written with the exact claim token; a stale attempt can therefore never complete an
 * event by authoring a result after its lease was reclaimed.
 */
export function createGmailEventProcessor(options: GmailEventProcessorOptions): EventProcessor {
  const now = options.now ?? (() => new Date().toISOString());
  return async (event): Promise<ProcessOutcome> => {
    if (event.leaseLost.aborted) {
      return { outcome: 'RETRYABLE_FAILURE', errorClass: 'LEASE_LOST', errorCode: 'E_LEASE_LOST' };
    }

    // Step 0: durable idempotency. A retry after a successful fenced write never invokes Gmail or
    // Workers AI again.
    let existing;
    try {
      existing = await getEnrichment(options.db, event.eventId);
    } catch (error) {
      // G2-only deployments predate migration 0002. Keep their source-neutral noop semantics
      // until the Gmail enrichment table is present; G3 production always has this table.
      if (
        options.compatibilityMode &&
        error instanceof Error &&
        /no such table/i.test(error.message)
      ) {
        return { outcome: 'SUCCESS' };
      }
      throw error;
    }
    if (existing) return { outcome: 'SUCCESS' };

    const result: GmailAIEnrichmentResult = await options.engine.enrich(
      event.eventId,
      event.leaseLost,
    );
    if (event.leaseLost.aborted) {
      return { outcome: 'RETRYABLE_FAILURE', errorClass: 'LEASE_LOST', errorCode: 'E_LEASE_LOST' };
    }

    if (
      result.outcome === 'DISABLED' ||
      result.outcome === 'POLICY_DENIED' ||
      result.outcome === 'QUOTA_EXHAUSTED'
    ) {
      // AI is an enrichment, not the durable-ingest availability boundary. These explicit degrade
      // outcomes still complete the event without fabricating a partial enrichment row.
      return { outcome: 'SUCCESS' };
    }

    const input =
      result.outcome === 'NO_CONTENT_DELETED'
        ? ({ status: 'NO_CONTENT_DELETED' } as const)
        : {
            status: 'COMPLETE' as const,
            summary: result.enrichment.summary.value,
            extractedJson: JSON.stringify({ signals: result.enrichment.signals }),
            modelId: result.enrichment.modelId,
          };
    const persisted = await persistEnrichment(options.db, {
      eventId: event.eventId,
      leaseToken: event.leaseToken,
      now: now(),
      input,
    });
    return persisted.outcome === 'LEASE_LOST'
      ? { outcome: 'RETRYABLE_FAILURE', errorClass: 'LEASE_LOST', errorCode: 'E_ENRICHMENT_FENCE' }
      : { outcome: 'SUCCESS' };
  };
}
