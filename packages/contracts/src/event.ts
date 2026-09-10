import { z } from 'zod';
import { ProvenanceValueSchema, SourceSchema } from './provenance.js';

/**
 * The connector-neutral normalized event envelope (TDD 13).
 *
 * Two properties of this schema are load-bearing invariants, not stylistic choices:
 *
 * 1. `.strict()` -- raw message bodies are NOT part of the central event contract (TDD 13,
 *    INV-12/INV-14). A permissive schema would let a connector attach `body`/`text`/`snippet`
 *    and have it flow into D1, the queue and the logs while every reviewer read the type
 *    definition and saw no such field. Strict mode makes that a parse failure at the boundary.
 *
 * 2. The telegram/ai_policy refinement below -- see its own comment.
 */

export const SCHEMA_VERSION = 3;

export const EVENT_TYPES = ['MESSAGE_CREATED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED'] as const;
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const DIRECTIONS = ['INBOUND', 'OUTBOUND'] as const;
export const DirectionSchema = z.enum(DIRECTIONS);
export type Direction = z.infer<typeof DirectionSchema>;

/**
 * A pointer to content, never the content itself. `kind` has one member today; it exists so a
 * future locator kind is an additive change rather than a reinterpretation of a bare string.
 */
export const ContentLocatorSchema = z
  .object({
    kind: z.literal('SOURCE_REF'),
    ref: z.string().min(1),
  })
  .strict();

export type ContentLocator = z.infer<typeof ContentLocatorSchema>;

const NormalizedEventBaseSchema = z
  .object({
    event_id: z.string().uuid(),
    source: SourceSchema,
    source_account_id: z.string().min(1),
    source_event_id: z.string().min(1),
    source_thread_id: z.string().min(1).nullable(),
    event_type: EventTypeSchema,
    direction: DirectionSchema,
    /** Provider-reported time the event happened. Source provenance (TDD 13). */
    occurred_at: z.string().datetime({ offset: true }),
    /**
     * Central transport bookkeeping. Becomes provenance-bearing the moment it is used to derive
     * business meaning such as urgency -- see TDD 13 and MIN-6.
     */
    received_at: z.string().datetime({ offset: true }),
    content_locator: ContentLocatorSchema,
    routing_hints: z.array(ProvenanceValueSchema),
    source_policy_id: z.string().min(1),
    trace_id: z.string().min(1),
    schema_version: z.literal(SCHEMA_VERSION),
  })
  .strict();

/**
 * Telegram-sourced events may not carry an AI_ALLOW routing hint.
 *
 * Every value extracted from Telegram content inherits Telegram provenance (INV-04), and
 * Telegram provenance is AI_DENY without exception in MVP1 (INV-03, core/SOURCE_POLICY.md).
 * Encoding that at the ingest boundary means a connector bug or a careless refactor produces a
 * loud parse failure rather than a value that looks AI-eligible three layers downstream, where
 * the reviewer reading the AI code has no way to tell where it came from.
 *
 * This is a boundary guard, not the AI boundary itself: the real enforcement is the type-level
 * restriction of the AI entry point to GmailEvidenceBundle plus the runtime provenance walk
 * (ADR-005, G2). Defence in depth -- do not let this check's existence justify weakening that one.
 */
export const NormalizedEventSchema = NormalizedEventBaseSchema.superRefine((event, ctx) => {
  if (event.source !== 'telegram') return;

  event.routing_hints.forEach((hint, index) => {
    if (hint.ai_policy === 'ALLOW') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routing_hints', index, 'ai_policy'],
        message:
          'Telegram-sourced routing hints are always AI_DENY (INV-03/INV-04); ' +
          'an ALLOW here means provenance was lost upstream.',
      });
    }
  });
});

export type NormalizedEvent = z.infer<typeof NormalizedEventBaseSchema>;

/**
 * The central idempotency key (TDD 14). Duplicate accepted submissions must resolve to the same
 * logical event, so this is derived from source-stable fields only -- never from `received_at`,
 * `trace_id` or `event_id`, which all differ across retries of the same source event.
 *
 * Length-prefixed rather than delimiter-joined: any single-character separator collides whenever
 * a field can contain it. With a space, ("a b", "c") and ("a", "b c") both render as "a b c", so
 * two distinct source events would share one key and one of them would be silently dropped as a
 * duplicate. Provider ids are opaque strings -- assume nothing about their alphabet.
 */
export function idempotencyKey(
  event: Pick<NormalizedEvent, 'source_account_id' | 'source_event_id' | 'event_type'>,
): string {
  return [event.source_account_id, event.source_event_id, event.event_type]
    .map((part) => `${part.length}:${part}`)
    .join('');
}
