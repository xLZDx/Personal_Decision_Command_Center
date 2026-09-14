/* global crypto, AbortSignal */
import type { ExportedHandler, MessageBatch } from '@cloudflare/workers-types';
import { QueuePayloadSchema, type QueuePayload } from '@pdos/contracts';
import type { EcdsaP256PublicJwk } from '@pdos/domain';

import { processMessage } from './handler.js';
import { GmailAIEngine } from '@pdos/policy';
import { createGmailEventProcessor } from './gmail-processor.js';
import type { ProcessorEnv } from './env.js';

export { processMessage } from './handler.js';
export type { ProcessMessageOptions, ProcessMessageResult } from './handler.js';
export { noopProcessor } from './processor.js';
export type { ClaimedEvent, EventProcessor, ProcessOutcome } from './processor.js';
export { createGmailEventProcessor } from './gmail-processor.js';
export type { GmailEventProcessorOptions } from './gmail-processor.js';
export type { ProcessorEnv } from './env.js';

/**
 * Every message is `ack()`ed after processing, success, failure, OR a wire-contract validation
 * failure alike -- retries in this system are driven entirely by the D1-backed outbox/reconciler
 * (TDD §17: "reconciler re-enqueues"), never by Cloudflare Queue's own native per-message retry.
 * Letting a failed message also retry at the Queue level would double-drive the same event through
 * two independent retry mechanisms with two different backoff schedules. `max_batch_size = 1`
 * (infra/cloudflare/processor.wrangler.toml, TDD §16.1) means this loop always has exactly one
 * message in production; it loops anyway so the same code is exercised the same way in tests with
 * a larger constructed batch.
 *
 * MAJOR fix (G2 gate review): the consumer previously trusted `message.body.eventId` as-is with no
 * runtime check -- a message that does not match the producer's own published wire contract
 * (`@pdos/contracts` `QueuePayloadSchema`, already defined from an earlier gate but never adopted
 * by either side of this Queue) would otherwise flow straight into `processMessage` as whatever
 * shape happened to deserialize. A malformed message is acked and skipped (D1 is the source of
 * truth for what still needs processing -- see the schema's own doc comment -- so there is nothing
 * a Queue-level retry of a message that never matched the contract could accomplish).
 */
async function queue(batch: MessageBatch<QueuePayload>, env: ProcessorEnv): Promise<void> {
  const now = new Date().toISOString();
  const process = makeConfiguredGmailProcessor(env, now);
  for (const message of batch.messages) {
    const parsed = QueuePayloadSchema.safeParse(message.body);
    if (!parsed.success) {
      message.ack();
      continue;
    }
    await processMessage(env.DB, {
      eventId: parsed.data.event_id,
      workerId: crypto.randomUUID(),
      now,
      traceId: message.id,
      ...(env.LEASE_DURATION_MS !== undefined
        ? { leaseDurationMs: Number(env.LEASE_DURATION_MS) }
        : {}),
      ...(env.MAX_PROCESSING_ATTEMPTS !== undefined
        ? { maxAttempts: Number(env.MAX_PROCESSING_ATTEMPTS) }
        : {}),
      ...(env.PROCESSOR_VERSION !== undefined ? { processorVersion: env.PROCESSOR_VERSION } : {}),
      ...(process === undefined ? {} : { process }),
    });
    message.ack();
  }
}

function makeConfiguredGmailProcessor(env: ProcessorEnv, now: string) {
  if (!env.GMAIL_CONTENT_GATEWAY || !env.WORKERS_AI || !env.GMAIL_CONTENT_ATTESTATION_PUBLIC_JWK) {
    return undefined;
  }
  const gateway = env.GMAIL_CONTENT_GATEWAY;
  let publicKey: EcdsaP256PublicJwk;
  try {
    publicKey = JSON.parse(env.GMAIL_CONTENT_ATTESTATION_PUBLIC_JWK) as EcdsaP256PublicJwk;
  } catch {
    throw new Error('GMAIL_CONTENT_ATTESTATION_PUBLIC_JWK must be valid JSON');
  }
  const messageLoader = {
    async loadMessage(opts: {
      eventId: string;
      sourceAccountId: string;
      messageId: string;
      signal?: AbortSignal;
    }) {
      const response = await gateway.fetch('https://gmail-content.internal/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eventId: opts.eventId,
          sourceAccountId: opts.sourceAccountId,
          messageId: opts.messageId,
        }),
      });
      if (!response.ok) throw new Error(`Gmail content gateway returned HTTP ${response.status}`);
      return (await response.json()) as {
        eventId: string;
        sourceAccountId: string;
        messageId: string;
        content: { subject: string; from: string; sentAt: string; plainText: string };
        signature: string;
      };
    },
  };
  const secrets = env.GMAIL_REDACTION_SECRETS_JSON
    ? (JSON.parse(env.GMAIL_REDACTION_SECRETS_JSON) as readonly string[])
    : undefined;
  const engine = new GmailAIEngine({
    db: env.DB,
    messageLoader,
    contentAttestationPublicKey: publicKey,
    ai: env.WORKERS_AI,
    now: () => now,
    ...(secrets === undefined ? {} : { secrets }),
  });
  return createGmailEventProcessor({ db: env.DB, engine, now: () => now });
}

export default {
  queue,
} satisfies ExportedHandler<ProcessorEnv, QueuePayload>;
