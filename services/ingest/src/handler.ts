import {
  HARD_BUDGET_CEILING,
  authenticateIngestRequest,
  canonicalSigningPayload,
  ingestEvent,
  reconcileDispatch,
  recoverStaleLeases,
  sha256Hex,
  type RecoveredLease,
  type ReconcileDispatchResult,
} from '@pdos/domain';
import { NormalizedEventSchema } from '@pdos/contracts';

import { resolveSecret, type IngestEnv } from './env.js';

// This module deliberately uses the GLOBAL (Node/undici) `Request`/`Response` types throughout,
// not `@cloudflare/workers-types`' own -- identical runtime objects under Node and Workers, and it
// keeps this file (and its tests, which construct plain `Request`s) free of a Workers-specific
// type. `index.ts`, which must satisfy `ExportedHandler`'s Workers-typed `fetch` signature, casts
// at that one boundary instead -- see the comment there for why.

/** TDD §16.1: initial max_batch_size is 1 event, so these defaults size the SCHEDULED handler's
 *  own per-invocation work, not the Queue consumer (that default lives in services/processor). */
const DEFAULT_MAX_PROCESSING_ATTEMPTS = 5;
const DEFAULT_RECONCILER_BATCH_SIZE = 25;
const DEFAULT_LEASE_RECOVERY_BATCH_SIZE = 25;
const DEFAULT_HMAC_TIMESTAMP_WINDOW_MS = 5 * 60_000;

const INGEST_PATH_RE = /^\/ingest\/(gmail|telegram)$/;

/**
 * Security fix (G2 review, MINOR): `x-key-version` previously flowed unvalidated straight into
 * `resolveSecret`'s binding-name lookup (`${connectorId}_${keyVersion}_HMAC_SECRET`). It was
 * already bounded from ever reaching a wrong SECRET (an attacker-controlled value just produces a
 * binding name that doesn't exist, so `resolveSecret` returns undefined and the request is
 * rejected as UNKNOWN_KEY) -- but nothing stopped an oversized or control-character-laden header
 * value from being echoed into a binding-name lookup and any log line built from it. A narrow
 * allowlist rejects a malformed value at the boundary, before it is used for anything.
 */
const KEY_VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The fetch handler: authenticate-before-D1-write, then idempotent insert. `now` is an explicit
 * parameter (defaulting to the real clock) so tests can drive the timestamp/nonce window and the
 * idempotency behavior deterministically, matching every domain function's own testability
 * convention.
 *
 * INV-12 note: a schema-validation failure below only ever echoes zod's own issue `path` (field
 * names) and `message` (a fixed, structural string) -- never a field VALUE -- because
 * `NormalizedEventSchema` is `.strict()` and defines no content-bearing field at all (ADR-004).
 * There is no raw source content in this envelope for an error response to leak.
 */
export async function handleIngestRequest(
  request: Request,
  env: IngestEnv,
  now: string = new Date().toISOString(),
): Promise<Response> {
  const url = new URL(request.url);
  const match = INGEST_PATH_RE.exec(url.pathname);
  if (!match) return jsonResponse(404, { error: 'NOT_FOUND' });
  const connectorId = match[1] as 'gmail' | 'telegram';

  if (request.method !== 'POST') return jsonResponse(405, { error: 'METHOD_NOT_ALLOWED' });

  const signatureHex = request.headers.get('x-signature');
  const timestamp = request.headers.get('x-timestamp');
  const nonce = request.headers.get('x-nonce');
  const keyVersion = request.headers.get('x-key-version');
  if (!signatureHex || !timestamp || !nonce || !keyVersion) {
    return jsonResponse(401, { error: 'MISSING_AUTH_HEADERS' });
  }
  if (!KEY_VERSION_RE.test(keyVersion)) {
    return jsonResponse(401, { error: 'INVALID_KEY_VERSION' });
  }

  const bodyText = await request.text();
  const bodyHash = await sha256Hex(bodyText);
  const payload = canonicalSigningPayload({
    method: request.method,
    path: url.pathname,
    timestamp,
    nonce,
    bodyHash,
  });

  const secret = resolveSecret(env, { connectorId, keyVersion });
  if (!secret) return jsonResponse(401, { error: 'UNKNOWN_KEY' });

  const authResult = await authenticateIngestRequest(env.DB, {
    connectorId,
    keyVersion,
    secret,
    timestamp,
    nonce,
    signatureHex,
    payload,
    now,
    timestampWindowMs: Number(env.HMAC_TIMESTAMP_WINDOW_MS ?? DEFAULT_HMAC_TIMESTAMP_WINDOW_MS),
  });
  if (!authResult.ok) return jsonResponse(401, { error: authResult.reason });

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    return jsonResponse(400, { error: 'INVALID_JSON' });
  }

  const eventResult = NormalizedEventSchema.safeParse(parsedBody);
  if (!eventResult.success) {
    return jsonResponse(400, {
      error: 'INVALID_EVENT',
      issues: eventResult.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    });
  }

  // A valid HMAC key proves "this caller may act as `connectorId`", not "this caller may claim any
  // `source`" -- without this check, a compromised or misconfigured Gmail key could inject an event
  // claiming source: 'telegram' and inherit whatever routing/AI-policy assumptions attach to it.
  if (eventResult.data.source !== connectorId) {
    return jsonResponse(400, { error: 'SOURCE_MISMATCH' });
  }

  const outcome = await ingestEvent(env.DB, eventResult.data);
  return jsonResponse(outcome.status === 'ACCEPTED' ? 202 : 200, outcome);
}

export interface ScheduledRunResult {
  leaseRecovery: RecoveredLease[];
  dispatch: ReconcileDispatchResult;
}

/**
 * The scheduled handler: Phase 1 stale-lease recovery, THEN Phase 2 budget-gated reconciler
 * dispatch (TDD §17) -- in that order, so a lease this same tick just reclaimed back to
 * RETRYABLE_FAILED is immediately eligible for Phase 2's own due-query, not stranded an extra
 * cron tick. Queue sends happen ONLY for event_ids `reconcileDispatch` already marked DISPATCHED
 * (budget reserved, outbox updated) -- never before, which is the HARD_ZERO fix `reconciler.ts`
 * documents.
 */
export async function handleScheduled(
  env: IngestEnv,
  now: string = new Date().toISOString(),
): Promise<ScheduledRunResult> {
  const maxAttempts = Number(env.MAX_PROCESSING_ATTEMPTS ?? DEFAULT_MAX_PROCESSING_ATTEMPTS);
  const cap = Number(env.QUEUE_BUDGET_CAP ?? HARD_BUDGET_CEILING);
  const day = now.slice(0, 10);

  const leaseRecovery = await recoverStaleLeases(env.DB, {
    now,
    maxAttempts,
    batchSize: Number(env.LEASE_RECOVERY_BATCH_SIZE ?? DEFAULT_LEASE_RECOVERY_BATCH_SIZE),
    processorVersion: 'stale-lease-recovery-sweep',
  });

  const dispatch = await reconcileDispatch(env.DB, {
    now,
    day,
    cap,
    maxAttempts,
    batchSize: Number(env.RECONCILER_BATCH_SIZE ?? DEFAULT_RECONCILER_BATCH_SIZE),
  });

  for (const eventId of dispatch.dispatched) {
    await env.INGEST_QUEUE.send({ eventId });
  }

  return { leaseRecovery, dispatch };
}
