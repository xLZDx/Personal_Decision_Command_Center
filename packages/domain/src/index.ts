export { isUniqueConstraintError } from './errors.js';

export { ingestEvent } from './ingest.js';
export type { IngestOutcome } from './ingest.js';

export { shouldMoveToDlq, moveToDlq, moveToRetryableFailed } from './transitions.js';
export type { LeaseFence, FailureContext, RetryableFailureContext } from './transitions.js';

export { claimLease, renewLease, completeProcessing, failProcessing } from './lease.js';
export type {
  ClaimOptions,
  ClaimResult,
  HeartbeatOptions,
  CompleteOptions,
  FailOptions,
  FailResult,
} from './lease.js';

export { recoverStaleLeases } from './lease-recovery.js';
export type { RecoverStaleLeasesOptions, RecoveredLease } from './lease-recovery.js';

export { HARD_BUDGET_CEILING, reserveBudget } from './budget.js';
export type { ReserveBudgetOptions, ReserveBudgetResult } from './budget.js';

export { reconcileDispatch } from './reconciler.js';
export type { ReconcileDispatchOptions, ReconcileDispatchResult } from './reconciler.js';

export { getOldestUnprocessedEvent } from './metrics.js';
export type { OldestUnprocessedEvent } from './metrics.js';

export {
  verifyHmacSignature,
  signHmac,
  canonicalSigningPayload,
  sha256Hex,
  isTimestampWithinWindow,
} from './auth/hmac.js';
export { reserveNonce, cleanupExpiredNonces } from './auth/nonce.js';
export type { ReserveNonceOptions } from './auth/nonce.js';
export { lookupSigningKeyStatus } from './auth/keys.js';
export type { SigningKeyLookupOptions, SigningKeyStatus } from './auth/keys.js';
export {
  authenticateIngestRequest,
  checkKeyAndTimestamp,
  checkSignatureAndNonce,
} from './auth/authenticate.js';
export type {
  AuthenticateIngestRequestOptions,
  AuthenticateIngestRequestReason,
  AuthenticateIngestRequestResult,
  CheckKeyAndTimestampOptions,
  CheckSignatureAndNonceOptions,
} from './auth/authenticate.js';

export {
  claimOrInspectDelivery,
  reclaimDelivery,
  renewDeliveryLease,
  completeDelivery,
  pruneCompletedPushDeliveries,
} from './gmail/push-lease.js';
export type {
  ClaimOrInspectOptions,
  ClaimOutcome,
  ReclaimOptions,
  ReclaimResult,
  DeliveryHeartbeatOptions,
  CompleteDeliveryOptions,
  PruneCompletedDeliveriesOptions,
} from './gmail/push-lease.js';

export { recoverStalePushDeliveries } from './gmail/push-lease-recovery.js';
export type {
  RecoverStalePushDeliveriesOptions,
  RecoveredPushDelivery,
} from './gmail/push-lease-recovery.js';

export { persistEnrichment, getEnrichment } from './gmail/enrichment.js';
export type {
  EnrichmentInput,
  PersistEnrichmentOptions,
  PersistEnrichmentResult,
  Enrichment,
} from './gmail/enrichment.js';
