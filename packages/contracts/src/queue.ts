import { z } from 'zod';
import { SCHEMA_VERSION } from './event.js';

/**
 * Queue payload (TDD 16).
 *
 * The queue carries a POINTER, never content: "No source body or source-derived display text is
 * placed in Queue" (TDD 16, INV-11/INV-12). `.strict()` makes an added `title`/`snippet`/`body`
 * field a parse failure instead of a privacy incident that also inflates Free-tier queue
 * operations -- Cloudflare bills one operation per 64 KB written, read or deleted, so a fat
 * payload costs quota three times over (docs/architecture/EXTERNAL_ASSUMPTIONS.md C).
 *
 * The consumer re-reads the authoritative event from D1 by `event_id`. That is deliberate:
 * D1 is the source of truth and the queue is transport (INV-09), so a stale or replayed queue
 * message can never carry stale STATE -- only a stale pointer to state that is re-read fresh.
 */

export const QUEUE_OPERATIONS = ['PROCESS_EVENT'] as const;
export const QueueOperationSchema = z.enum(QUEUE_OPERATIONS);
export type QueueOperation = z.infer<typeof QueueOperationSchema>;

export const QueuePayloadSchema = z
  .object({
    event_id: z.string().uuid(),
    operation: QueueOperationSchema,
    schema_version: z.literal(SCHEMA_VERSION),
  })
  .strict();

export type QueuePayload = z.infer<typeof QueuePayloadSchema>;

/**
 * Push notification payload (TDD 32, ADR-008).
 *
 * Opaque by construction: no sender, no title, no decision question, no deadline, no project
 * label, no source-derived text of any kind. The client wakes and performs an authenticated
 * state fetch. `.strict()` is the mechanical part of "push payload inspected and proven opaque"
 * in the PWA/Push DoD (TDD 75) -- a reviewer reading this type cannot be fooled by a field added
 * elsewhere, because an extra field will not parse.
 */
export const PUSH_TYPES = ['STATE_CHANGED'] as const;
export const PushTypeSchema = z.enum(PUSH_TYPES);
export type PushType = z.infer<typeof PushTypeSchema>;

export const PUSH_SCHEMA_VERSION = 1;

export const PushPayloadSchema = z
  .object({
    type: PushTypeSchema,
    notification_id: z.string().min(1),
    schema_version: z.literal(PUSH_SCHEMA_VERSION),
  })
  .strict();

export type PushPayload = z.infer<typeof PushPayloadSchema>;
