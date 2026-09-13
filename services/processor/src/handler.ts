/* global AbortController, setTimeout, clearTimeout */
import { claimLease, completeProcessing, failProcessing, renewLease } from '@pdos/domain';
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
  /** How often to renew the held lease while `process()` is still running. Defaults to half the
   *  lease duration -- the same margin the claim/renewal design already assumes elsewhere, so a
   *  single missed tick (a slow renewal call itself) still leaves room for a second attempt before
   *  the lease actually expires. */
  heartbeatIntervalMs?: number;
  /** Called fresh for each heartbeat renewal tick -- defaults to the real clock. Injectable, like
   *  every other domain function's own `now` parameter, so a long-running-processor test can drive
   *  a genuinely slow attempt deterministically without a real wall-clock delay. Deliberately NOT
   *  the same fixed `now` this function's own claim/complete/fail calls use: a heartbeat's entire
   *  purpose is to reflect ACTUAL elapsed time, so reusing one frozen timestamp across every tick
   *  would never advance the lease's expiry at all (GPT-PM BLOCKER, G2 gate review: "using a fresh
   *  clock"). */
  heartbeatNow?: () => string;
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
 * Runs `renewLease` on a fixed interval for as long as processing continues, using a FRESH clock
 * reading on every tick (never the invocation's own frozen `now`) -- GPT-PM BLOCKER, G2 gate
 * review: `renewLease` existed as a correctly-fenced helper from checkpoint 1 but nothing ever
 * called it during processing, so ANY attempt genuinely taking longer than the fixed lease TTL
 * (120s default) -- not a hang, just real I/O latency -- would be wrongly reclaimed by the
 * stale-lease-recovery sweep while still actively running. Stops scheduling further ticks the
 * moment a renewal reports the fence lost (a sweep already reclaimed this lease): a lease that is
 * already gone will not come back by trying again.
 *
 * @returns a stop function the caller MUST call once `process()` settles, success or failure alike
 * (a `finally` block), or the timer would keep firing after this invocation has nothing left to
 * renew.
 */
function startHeartbeat(params: {
  db: D1Database;
  eventId: string;
  token: string;
  leaseDurationMs: number;
  intervalMs: number;
  nowFn: () => string;
  onLost: () => void;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void (async () => {
        if (stopped) return;
        // MAJOR fix (GPT-PM, G2 gate review round 2): a transient D1/runtime error from
        // `renewLease` itself (not merely a fenced "false") previously propagated as an unhandled
        // rejection inside this fire-and-forget tick, AND `onLost()` was never called -- so the
        // lease's real safety contract (leaseLost fires whenever renewal cannot be PROVEN to have
        // succeeded) silently didn't hold for this failure mode. "Cannot prove renewal" is treated
        // exactly like "renewal reported false": stop scheduling and signal lease loss, never keep
        // running under a lease this call could not actually confirm.
        let renewed: boolean;
        try {
          renewed = await renewLease(params.db, {
            eventId: params.eventId,
            token: params.token,
            now: params.nowFn(),
            leaseDurationMs: params.leaseDurationMs,
          });
        } catch {
          if (stopped) return;
          params.onLost();
          return;
        }
        if (stopped) return;
        if (!renewed) {
          params.onLost();
          return;
        }
        scheduleNext();
      })();
    }, params.intervalMs);
  };
  scheduleNext();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
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
  const heartbeatIntervalMs =
    opts.heartbeatIntervalMs ?? Math.max(1000, Math.floor(leaseDurationMs / 2));
  const heartbeatNow = opts.heartbeatNow ?? (() => new Date().toISOString());

  const claim = await claimLease(db, {
    eventId: opts.eventId,
    workerId: opts.workerId,
    leaseDurationMs,
    now: opts.now,
    processorVersion,
    traceId,
    maxAttempts,
  });
  if (!claim.claimed) return { claimed: false };

  const leaseLostController = new AbortController();
  const stopHeartbeat = startHeartbeat({
    db,
    eventId: opts.eventId,
    token: claim.token,
    leaseDurationMs,
    intervalMs: heartbeatIntervalMs,
    nowFn: heartbeatNow,
    onLost: () => leaseLostController.abort(),
  });

  let outcome: ProcessOutcome;
  try {
    outcome = await process({
      eventId: opts.eventId,
      attemptNumber: claim.attemptNumber,
      leaseLost: leaseLostController.signal,
    });
  } catch (error) {
    outcome = {
      outcome: 'RETRYABLE_FAILURE',
      errorClass: error instanceof Error ? error.constructor.name : 'UnknownError',
      errorCode: 'E_PROCESSOR_THREW',
    };
  } finally {
    stopHeartbeat();
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
