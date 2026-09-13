/* global crypto */
import type { ExportedHandler, MessageBatch } from '@cloudflare/workers-types';
import { QueuePayloadSchema, type QueuePayload } from '@pdos/contracts';

import { processMessage } from './handler.js';
import type { ProcessorEnv } from './env.js';

export { processMessage } from './handler.js';
export type { ProcessMessageOptions, ProcessMessageResult } from './handler.js';
export { noopProcessor } from './processor.js';
export type { ClaimedEvent, EventProcessor, ProcessOutcome } from './processor.js';
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
    });
    message.ack();
  }
}

export default {
  queue,
} satisfies ExportedHandler<ProcessorEnv, QueuePayload>;
