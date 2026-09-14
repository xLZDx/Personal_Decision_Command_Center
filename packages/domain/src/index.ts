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
export {
  verifyEcdsaP256Signature,
  signEcdsaP256Signature,
  importEcdsaP256PrivateJwk,
} from './auth/ecdsa.js';
export type { EcdsaP256PublicJwk } from './auth/ecdsa.js';
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

export { importKek, encryptRefreshToken, decryptRefreshToken } from './gmail/crypto.js';
export type { EncryptedRefreshToken, RefreshTokenAad } from './gmail/crypto.js';
export { parseTelegramDeterministically } from './telegram/parser.js';
export type {
  TelegramDeterministicSignal,
  TelegramParserInput,
  TelegramSignalKind,
} from './telegram/parser.js';
export { classifyTelegramIntent, TELEGRAM_INTENT_CLASSES } from './telegram/intent.js';
export type { TelegramIntentClass, TelegramIntentResult } from './telegram/intent.js';
export { resolveTopicDeterministically } from './resolver/topic.js';
export type { TopicCandidate, TopicResolution, TopicResolutionResult } from './resolver/topic.js';

export {
  generateRandomToken,
  computeCodeChallenge,
  createOAuthFlow,
  consumeOAuthFlow,
  connectGmailAccount,
  disconnectGmailAccount,
  DisconnectAmbiguousExternalCallError,
  DisconnectRecoveryMarkerWriteFailedError,
  LifecycleLockRecoveryFailedError,
  ConnectLockLostBeforeWriteError,
  listWedgedGmailDisconnectLocks,
  reconcileWedgedGmailDisconnectLock,
} from './gmail/oauth.js';
export type {
  CreateOAuthFlowOptions,
  ConsumeOAuthFlowOptions,
  ConsumeOAuthFlowResult,
  GoogleOAuthClient,
  GoogleTokenExchangeResult,
  CollectionMode,
  ConnectGmailAccountOptions,
  ConnectGmailAccountResult,
  DisconnectGmailAccountOptions,
  DisconnectGmailAccountResult,
  GmailDisconnectOutcomeUnknownPhase,
  WedgedGmailDisconnectLock,
  ReconcileWedgedGmailDisconnectLockOptions,
  ReconcileWedgedGmailDisconnectLockResult,
} from './gmail/oauth.js';

export {
  syncGmailAccountHistory,
  GmailHistoryCursorInvalidError,
  GmailHistoryCursorMissingBootstrapError,
  RECOMMENDED_MAX_EXTERNAL_CALLS_PER_INVOCATION,
} from './gmail/history-sync.js';
export type {
  GmailMessageRef,
  GmailHistoryRecord,
  GmailHistoryPage,
  GmailMessageMetadata,
  GmailListMessagesInWindowResult,
  GmailHistoryClient,
  GmailEventSubmitResult,
  GmailEventSubmitter,
  GmailCursorValue,
  GmailHistorySyncCounts,
  SyncGmailAccountHistoryResult,
  SyncGmailAccountHistoryOptions,
} from './gmail/history-sync.js';

export {
  GMAIL_RATE_LIMIT_PER_MINUTE,
  GMAIL_RATE_WINDOW_CEILING,
  GMAIL_API_DAILY_CEILING,
  GMAIL_AI_NEURON_DAILY_CEILING,
  GMAIL_API_UNIT_COST,
  reserveGmailRateWindow,
  reserveGmailApiUnits,
  reserveGmailAiNeurons,
  reconcileGmailAiNeurons,
} from './gmail/quota.js';
export type {
  ReserveGmailRateWindowOptions,
  ReserveGmailRateWindowResult,
  ReserveGmailApiUnitsOptions,
  ReserveGmailApiUnitsResult,
  ReserveGmailAiNeuronsOptions,
  ReserveGmailAiNeuronsResult,
  ReconcileGmailAiNeuronsOptions,
  ReconcileGmailAiNeuronsResult,
  ReconcileGmailAiNeuronsOutcome,
} from './gmail/quota.js';
