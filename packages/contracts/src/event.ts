import { z } from 'zod';
import { provenanceValueSchema, SourceSchema } from './provenance.js';

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

export const SCHEMA_VERSION = 4;

/**
 * G2 fix: an unbounded routing_hints array has no defined cost ceiling against the D1/quota
 * budget this gate is explicitly bound by (each hint is its own row in
 * ingest_event_routing_hints). 16 is a deliberately generous cap for MVP1's actual connectors
 * (Gmail/Telegram), not a measured production ceiling -- revisit if a real connector needs more.
 */
export const MAX_ROUTING_HINTS = 16;

/**
 * Security fix (G2 review, MAJOR): `routing_hints[].value` previously inherited the generic
 * provenance value schema's unbounded `z.string().min(1)`, with no cost or content ceiling of its
 * own -- a routing hint is metadata (a category, a tag, a classification), not content (INV-12/
 * INV-14), and an unbounded length let raw connector body text be smuggled in disguised as one,
 * indistinguishable from a legitimate hint by any downstream reader of this type. 512 is a
 * deliberately generous bound for a routing/classification value, far short of a realistic message
 * body, matched by a DB-level CHECK on ingest_event_routing_hints.value (migration 0001).
 */
export const MAX_ROUTING_HINT_VALUE_LENGTH = 512;
const RoutingHintValueSchema = z.string().min(1).max(MAX_ROUTING_HINT_VALUE_LENGTH);
const RoutingHintSchema = provenanceValueSchema(RoutingHintValueSchema);

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

/**
 * G2 fix (M4, closed across 2 rounds): a source-reported revision/version marker for the event's
 * underlying content, mandatory for MESSAGE_UPDATED so idempotencyKey() can distinguish distinct
 * edits of the same source event instead of colliding them onto one idempotency key. Uses a
 * NON-MUTATING predicate rather than `.trim().min(1)`: Zod's `.trim()` is a string TRANSFORM that
 * would silently alter the parsed value, which would then diverge from the ORIGINAL string used
 * for storage/idempotency identity. Whitespace-only ("", " ", "\t") is rejected without changing
 * a legitimately padded-but-real revision string.
 */
export const SourceVersionSchema = z
  .string()
  .refine((v) => v.trim().length > 0, {
    message: 'source_version must not be empty or whitespace-only',
  })
  .nullable();

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
     * Whether `occurred_at` above is genuinely the SOURCE's own reported time
     * (`'PROVIDER_REPORTED'`, the default -- every existing producer/consumer is unaffected) or a
     * connector's best estimate because the source exposes no per-signal timestamp at all
     * (`'ESTIMATED_FROM_RECEIPT'`). G3 checkpoint 5, GPT-PM round-2 MAJOR (2026-09-13, ruling
     * option (b)): Gmail's `history.list` carries no timestamp for deletions or label changes, and
     * silently writing processing time into `occurred_at` for those events made a transport
     * observation indistinguishable from real provider provenance to any downstream ordering/
     * latency consumer -- a genuine contract violation, not merely an approximation (see ADR-004).
     * Additive and backward-compatible: an existing producer that never sets this field gets the
     * default, preserving its exact current semantics.
     */
    occurred_at_quality: z
      .enum(['PROVIDER_REPORTED', 'ESTIMATED_FROM_RECEIPT'])
      .default('PROVIDER_REPORTED'),
    /**
     * Central transport bookkeeping. Becomes provenance-bearing the moment it is used to derive
     * business meaning such as urgency -- see TDD 13 and MIN-6.
     */
    received_at: z.string().datetime({ offset: true }),
    content_locator: ContentLocatorSchema,
    routing_hints: z.array(RoutingHintSchema).max(MAX_ROUTING_HINTS),
    source_policy_id: z.string().min(1),
    trace_id: z.string().min(1),
    schema_version: z.literal(SCHEMA_VERSION),
    /** Nullable at the type level; MESSAGE_UPDATED's own superRefine below makes it mandatory. */
    source_version: SourceVersionSchema,
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
  if (event.source === 'telegram') {
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
  }

  // G2 fix (M4): MESSAGE_UPDATED structurally requires a non-null source_version, so
  // idempotencyKey() has a real revision marker to distinguish distinct edits of the same source
  // event -- not merely a documented convention a connector could silently skip.
  if (event.event_type === 'MESSAGE_UPDATED' && event.source_version === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['source_version'],
      message: 'MESSAGE_UPDATED requires a non-null source_version to remain idempotent.',
    });
  }
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
 *
 * G2 fix (M4): a 4th component, source_version, so a MESSAGE_UPDATED submission of a genuinely
 * new revision gets a DIFFERENT idempotency key than the original MESSAGE_CREATED/prior revision,
 * instead of colliding on (account, source_event_id, event_type) alone. A null source_version
 * (MESSAGE_CREATED/MESSAGE_DELETED) is length-prefixed as the empty string, matching every other
 * component's own length-prefix discipline.
 */
export function idempotencyKey(
  event: Pick<
    NormalizedEvent,
    'source_account_id' | 'source_event_id' | 'event_type' | 'source_version'
  >,
): string {
  return [
    event.source_account_id,
    event.source_event_id,
    event.event_type,
    event.source_version ?? '',
  ]
    .map((part) => `${part.length}:${part}`)
    .join('');
}
