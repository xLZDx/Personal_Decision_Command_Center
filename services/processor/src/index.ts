import type { ExportedHandler, MessageBatch } from '@cloudflare/workers-types';

import { processMessage } from './handler.js';
import type { DispatchMessage, ProcessorEnv } from './env.js';

export { processMessage } from './handler.js';
export type { ProcessMessageOptions, ProcessMessageResult } from './handler.js';
export { noopProcessor } from './processor.js';
export type { ClaimedEvent, EventProcessor, ProcessOutcome } from './processor.js';
export type { DispatchMessage, ProcessorEnv } from './env.js';

/**
 * Every message is `ack()`ed after `processMessage` runs, success or failure alike -- retries in
 * this system are driven entirely by the D1-backed outbox/reconciler (TDD §17: "reconciler
 * re-enqueues"), never by Cloudflare Queue's own native per-message retry. Letting a failed
 * message also retry at the Queue level would double-drive the same event through two independent
 * retry mechanisms with two different backoff schedules. `max_batch_size = 1`
 * (infra/cloudflare/processor.wrangler.toml, TDD §16.1) means this loop always has exactly one
 * message in production; it loops anyway so the same code is exercised the same way in tests with
 * a larger constructed batch.
 */
async function queue(batch: MessageBatch<DispatchMessage>, env: ProcessorEnv): Promise<void> {
  const now = new Date().toISOString();
  for (const message of batch.messages) {
    await processMessage(env.DB, {
      eventId: message.body.eventId,
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
} satisfies ExportedHandler<ProcessorEnv, DispatchMessage>;
