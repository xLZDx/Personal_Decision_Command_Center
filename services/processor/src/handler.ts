import { claimLease, completeProcessing, failProcessing } from '@pdos/domain';
import type { D1Database } from '@cloudflare/workers-types';

import { noopProcessor, type EventProcessor, type ProcessOutcome } from './processor.js';

const DEFAULT_MAX_PROCESSING_ATTEMPTS = 5;
const DEFAULT_LEASE_DURATION_MS = 120_000;
const DEFAULT_BACKOFF_CAP_MS = 5 * 60_000;

export interface ProcessMessageOptions {
  eventId: string;
  workerId: string;
  now: string;
  leaseDurationMs?: number;
  maxAttempts?: number;
  processorVersion?: string;
  traceId?: string;
  process?: EventProcessor;
}

export interface ProcessMessageResult {
  claimed: boolean;
  transitioned?: boolean;
  movedToDlq?: boolean;
}

function backoffMs(attemptNumber: number): number {
  return Math.min(2 ** attemptNumber * 1000, DEFAULT_BACKOFF_CAP_MS);
}

/**
 * One event's worth of the claim -> process -> complete/fail lifecycle. A processor exception is
 * caught and treated as a RETRYABLE_FAILURE rather than propagating -- a thrown error must still
 * release the lease and record an attempt, exactly like any other failure outcome, or the event
 * would sit PROCESSING until the stale-lease-recovery sweep eventually reclaims it many minutes
 * later for no reason (the sweep exists for a genuinely crashed/hung worker, not an ordinary
 * caught exception this same invocation is still alive to record).
 */
export async function processMessage(
  db: D1Database,
  opts: ProcessMessageOptions,
): Promise<ProcessMessageResult> {
  const leaseDurationMs = opts.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_PROCESSING_ATTEMPTS;
  const processorVersion = opts.processorVersion ?? 'processor-v1';
  const traceId = opts.traceId ?? opts.eventId;
  const process = opts.process ?? noopProcessor;

  const claim = await claimLease(db, {
    eventId: opts.eventId,
    workerId: opts.workerId,
    leaseDurationMs,
    now: opts.now,
    processorVersion,
    traceId,
  });
  if (!claim.claimed) return { claimed: false };

  let outcome: ProcessOutcome;
  try {
    outcome = await process({ eventId: opts.eventId, attemptNumber: claim.attemptNumber });
  } catch (error) {
    outcome = {
      outcome: 'RETRYABLE_FAILURE',
      errorClass: error instanceof Error ? error.constructor.name : 'UnknownError',
      errorCode: 'E_PROCESSOR_THREW',
    };
  }

  if (outcome.outcome === 'SUCCESS') {
    const transitioned = await completeProcessing(db, {
      eventId: opts.eventId,
      token: claim.token,
      now: opts.now,
    });
    return { claimed: true, transitioned };
  }

  const nextAttemptAt = new Date(
    Date.parse(opts.now) + backoffMs(claim.attemptNumber),
  ).toISOString();
  const result = await failProcessing(db, {
    eventId: opts.eventId,
    token: claim.token,
    now: opts.now,
    outcome: outcome.outcome,
    attemptCountAtFailure: claim.attemptNumber,
    maxAttempts,
    nextAttemptAt,
    errorClass: outcome.errorClass,
    errorCode: outcome.errorCode,
    processorVersion,
    traceId,
  });
  return { claimed: true, transitioned: result.transitioned, movedToDlq: result.movedToDlq };
}
