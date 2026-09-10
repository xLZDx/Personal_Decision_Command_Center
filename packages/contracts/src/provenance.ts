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
 * A single content-derived value, carrying the evidence that produced it.
 *
 * `provenance` holds source-event ids; an empty array is rejected because a value with no
 * recorded ancestry cannot be shown to be AI-safe, and silently treating "no ancestors" as
 * "no restricted ancestors" is exactly the fail-open the composition rule forbids.
 */
export const ProvenanceValueSchema = z
  .object({
    value: z.string().min(1),
    provenance: z.array(z.string().min(1)).min(1),
    derivation_method: DerivationMethodSchema,
    ai_policy: AiPolicySchema,
  })
  .strict();

export type ProvenanceValue = z.infer<typeof ProvenanceValueSchema>;
