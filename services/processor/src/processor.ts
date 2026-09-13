/* global AbortSignal */
export interface ClaimedEvent {
  eventId: string;
  attemptNumber: number;
  /**
   * Fires once a heartbeat renewal has lost the fence -- the stale-lease-recovery sweep already
   * reclaimed this lease while `process()` was still running (GPT-PM BLOCKER, G2 gate review: the
   * heartbeat/renewal mechanism existed as a helper but was never wired into the processing
   * lifecycle, so a healthy but slow attempt exceeding the fixed lease TTL could be reclaimed out
   * from under it). A cooperative real `EventProcessor` should check this signal and abandon any
   * further external work as soon as practical -- the data layer is already safe regardless
   * (`completeProcessing`/`failProcessing` are token-fenced, so a stale completion after the fence
   * is lost simply reports `transitioned: false` rather than corrupting state), but this signal
   * lets a real implementation avoid wasting further external work under a lease it no longer
   * holds. G2's own `noopProcessor` does no external work, so it has nothing to check this
   * against -- the real business logic (and its use of this signal) is a later gate's own scope.
   */
  leaseLost: AbortSignal;
}

export type ProcessOutcome =
  | { outcome: 'SUCCESS' }
  | { outcome: 'RETRYABLE_FAILURE' | 'PERMANENT_FAILURE'; errorClass: string; errorCode: string };

/**
 * The actual downstream business logic (topic assignment, AI extraction, and whatever else a
 * PROCESSED event eventually drives) is explicitly OUT of G2's scope -- see this gate's own
 * manifest (`governance/gate-manifests/g2.yaml`): "D1 schema, provenance primitives, durable
 * ingest/outbox pipeline, Queue reconciler/DLQ with a fenced processing lease, and the soft-budget
 * guard." G2's deliverable is the LEASE MACHINERY (claim/heartbeat/complete/fail, fenced against
 * the stale-lease-recovery sweep), proven correct independent of what "processing" eventually
 * means -- so this is an injected strategy, not a hardcoded call into logic that doesn't exist
 * yet. A later gate supplies a real `EventProcessor`; this file's own default is a placeholder
 * that always succeeds, standing in for "processing happened" long enough to prove the pipeline
 * moves an event through to PROCESSED end-to-end.
 */
export type EventProcessor = (event: ClaimedEvent) => Promise<ProcessOutcome>;

export const noopProcessor: EventProcessor = async () => ({ outcome: 'SUCCESS' });
