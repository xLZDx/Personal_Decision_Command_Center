export interface ClaimedEvent {
  eventId: string;
  attemptNumber: number;
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
