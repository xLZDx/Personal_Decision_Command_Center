import { z } from 'zod';

/**
 * Provenance primitives shared by every contract.
 *
 * This module defines the SHAPE only. The DAG traversal, the `ai_safe()` composition rule and
 * `assert_ai_safe()` are G2 (`packages/provenance`) -- see core/adr/ADR-005-value-provenance-dag.md.
 * Nothing here should be mistaken for enforcement of the AI boundary; a type that carries an
 * `ai_policy` field does not by itself stop anyone from serializing it.
 */

export const SOURCES = ['telegram', 'gmail'] as const;
export const SourceSchema = z.enum(SOURCES);
export type Source = z.infer<typeof SourceSchema>;

/**
 * How a value came to exist. A value that is not derived from source content at all
 * (STATIC_CONFIG) is the only kind that can be AI_ALLOW independently of its ancestors.
 */
export const DERIVATION_METHODS = [
  'RULE',
  'STATIC_CONFIG',
  'PROVIDER_METADATA',
  'AI_EXTRACTION',
] as const;
export const DerivationMethodSchema = z.enum(DERIVATION_METHODS);
export type DerivationMethod = z.infer<typeof DerivationMethodSchema>;

/**
 * ALLOW / DENY only. There is deliberately no `UNKNOWN` member: TDD 7.2 requires unknown or
 * mixed ancestry to resolve to DENY, so an explicit UNKNOWN state would create a third value
 * that some future `if (policy === 'DENY')` check would fall through. Absence of a decision is
 * represented by failing to parse, not by a permissive third state.
 */
export const AI_POLICIES = ['ALLOW', 'DENY'] as const;
export const AiPolicySchema = z.enum(AI_POLICIES);
export type AiPolicy = z.infer<typeof AiPolicySchema>;

/**
 * G2 V3 fix (GPT-PM MAJOR M5, Round 3): the TDD lists `sensitivity` as a normal, non-optional
 * member of `ProvenanceValue<T>`, but its VALUE SET is not ratified anywhere -- so this is a
 * required, non-empty opaque string, not an invented LOW/MEDIUM/HIGH enum. A closed vocabulary is
 * a separate, later decision GPT-PM explicitly declined to make on this project's behalf.
 *
 * MAJOR fix (G2 gate review): `z.string().min(1)` alone accepts a whitespace-only string ("   ")
 * as non-empty, and has no upper bound -- an unbounded field stored straight into
 * `ingest_event_routing_hints.sensitivity` (migration 0001) could be used to inflate row size with
 * no schema-level ceiling. Uses the same NON-MUTATING trimmed-nonempty predicate as
 * `SourceVersionSchema` (packages/contracts/src/event.ts) rather than `.trim().min(1)`, which would
 * silently alter the parsed value away from what is actually stored. The upper bound matches the
 * DB CHECK constraint added alongside this fix (migration 0001).
 */
export const MAX_SENSITIVITY_LENGTH = 128;

export const SensitivitySchema = z
  .string()
  .max(MAX_SENSITIVITY_LENGTH)
  .refine((v) => v.trim().length > 0, {
    message: 'sensitivity must not be empty or whitespace-only',
  });
export type Sensitivity = z.infer<typeof SensitivitySchema>;

/**
 * G2 V3 fix (GPT-PM MAJOR M5, Round 2): `provenance` is unconditionally non-empty EXCEPT for a
 * STATIC_CONFIG-derived value, which is structurally licensed to have zero ancestors -- matching
 * packages/provenance's StaticConfigNodeSchema exactly, not merely by convention.
 */
export function provenanceValueSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z
    .object({
      value: valueSchema,
      provenance: z.array(z.string().min(1)),
      derivation_method: DerivationMethodSchema,
      ai_policy: AiPolicySchema,
      sensitivity: SensitivitySchema,
      created_at: z.string().datetime({ offset: true }),
      derivation_version: z.number().int().positive(),
    })
    .strict()
    .superRefine((v, ctx) => {
      if (v.derivation_method !== 'STATIC_CONFIG' && v.provenance.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['provenance'],
          message:
            'Non-STATIC_CONFIG values must carry at least one provenance id; only a ' +
            'STATIC_CONFIG-derived value may be a genuine zero-ancestor root.',
        });
      }
    });
}

export const StringProvenanceValueSchema = provenanceValueSchema(z.string().min(1));
export type StringProvenanceValue = z.infer<typeof StringProvenanceValueSchema>;

export const NumberProvenanceValueSchema = provenanceValueSchema(z.number());
export const DatetimeProvenanceValueSchema = provenanceValueSchema(
  z.string().datetime({ offset: true }),
);
export const BooleanProvenanceValueSchema = provenanceValueSchema(z.boolean());

export function enumProvenanceValueSchema<T extends [string, ...string[]]>(values: T) {
  return provenanceValueSchema(z.enum(values));
}

/** Kept for callers that only need the legacy string-only shape without importing the factory. */
export const ProvenanceValueSchema = StringProvenanceValueSchema;
export type ProvenanceValue = StringProvenanceValue;
