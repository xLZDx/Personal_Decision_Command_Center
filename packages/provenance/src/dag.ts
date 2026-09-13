import { z } from 'zod';
import { AiPolicySchema, SourceSchema } from '@pdos/contracts';
import type { Source } from '@pdos/contracts';
import type { SourcePolicyLookup } from './source-policy.js';

/**
 * Provenance DAG traversal and the `ai_safe()` composition rule (ADR-005, TDD §7.2).
 *
 * This module is the "testable primitive" ADR-005 requires, not documentation: `packages/policy`
 * or a future AI serializer calls `assertAiSafe()` and gets a thrown error, not a comment telling
 * a human to check something.
 *
 * The graph: `SourceEvent -> ProvenanceValue/ProvenanceAssignment -> SourceEnrichment ->
 * TopicAssignment/DecisionEvidence -> Decision/Commitment/Milestone` (TDD §7). Every node in that
 * chain is modeled here as a `ProvenanceNode`, a discriminated union of three shapes -- so "genuine
 * root with no ancestors" is a TYPE, not a doc-comment convention a caller can accidentally satisfy
 * with any empty array on a loose interface.
 *
 * Composition rule (TDD §7.2, verbatim): "ai_safe(value) = all provenance ancestors are AI_ALLOW.
 * Unknown/mixed ancestry = AI_DENY." Four distinct fail-closed cases, each deliberate:
 *
 * 1. `candidate` fails schema validation entirely (wrong shape, unknown kind) -> DENY. A caller
 *    must never be able to pass an untyped/malformed object and have it silently treated as safe.
 * 2. The node's own `ai_policy` is anything other than the literal string ALLOW -> DENY. This is
 *    an EXPLICIT-ALLOW check, not `!== 'DENY'`: if the policy vocabulary ever grows a third value,
 *    this fails closed automatically instead of silently treating the new value as safe.
 * 3. Any ancestor id the lookup cannot resolve ("unknown ancestry") -> DENY. A caller that has not
 *    yet loaded the full ancestor chain must never be able to make that look like "no restricted
 *    ancestors" by returning `undefined` and having the traversal shrug it off.
 * 4. A cycle (a node reachable from itself) -> DENY. A DAG should never contain one, but a bug
 *    producing one must never resolve to an infinite loop, and must never resolve to ALLOW either
 *    -- both would be worse than a loud, safe refusal.
 */

export const NodeIdSchema = z.string().min(1);
export type NodeId = z.infer<typeof NodeIdSchema>;

export const SourceEventNodeSchema = z
  .object({
    kind: z.literal('SOURCE_EVENT'),
    id: NodeIdSchema,
    source: SourceSchema,
    ai_policy: AiPolicySchema,
    provenance: z.tuple([]),
  })
  .strict();

export const StaticConfigNodeSchema = z
  .object({
    kind: z.literal('STATIC_CONFIG'),
    id: NodeIdSchema,
    ai_policy: AiPolicySchema,
    provenance: z.tuple([]),
  })
  .strict();

export const DerivedNodeSchema = z
  .object({
    kind: z.literal('DERIVED'),
    id: NodeIdSchema,
    ai_policy: AiPolicySchema,
    provenance: z.array(NodeIdSchema).min(1),
  })
  .strict();

export const ProvenanceNodeSchema = z.discriminatedUnion('kind', [
  SourceEventNodeSchema,
  StaticConfigNodeSchema,
  DerivedNodeSchema,
]);

export type SourceEventNode = z.infer<typeof SourceEventNodeSchema>;
export type StaticConfigNode = z.infer<typeof StaticConfigNodeSchema>;
export type DerivedNode = z.infer<typeof DerivedNodeSchema>;
export type ProvenanceNode = z.infer<typeof ProvenanceNodeSchema>;

export function makeStaticConfigNode(id: NodeId, ai_policy: 'ALLOW' | 'DENY'): StaticConfigNode {
  return StaticConfigNodeSchema.parse({ kind: 'STATIC_CONFIG', id, ai_policy, provenance: [] });
}

export function makeDerivedNode(
  id: NodeId,
  ai_policy: 'ALLOW' | 'DENY',
  provenance: NodeId[],
): DerivedNode {
  return DerivedNodeSchema.parse({ kind: 'DERIVED', id, ai_policy, provenance });
}

/** Returns `unknown` deliberately -- the ancestor is re-validated by `isAiSafe` on each recursive
 *  step, not trusted just because a lookup produced something. */
export type ProvenanceLookup = (id: NodeId) => unknown;

export class ProvenanceViolationError extends Error {
  constructor(
    message: string,
    public readonly nodeId: NodeId,
  ) {
    super(message);
    this.name = 'ProvenanceViolationError';
  }
}

/**
 * @returns true only if `candidate` validates as a real `ProvenanceNode`, its own `ai_policy` is
 * explicitly ALLOW, and every transitive ancestor is also AI-safe. Fails closed on a malformed
 * candidate, a DENY (or any non-ALLOW) node, an unresolved ancestor id, or a cycle.
 */
export function isAiSafe(
  candidate: unknown,
  lookup: ProvenanceLookup,
  seen: Set<NodeId> = new Set(),
): boolean {
  const parsed = ProvenanceNodeSchema.safeParse(candidate);
  if (!parsed.success) return false;
  const node = parsed.data;

  if (node.ai_policy !== 'ALLOW') return false;
  if (seen.has(node.id)) return false;

  const visited = new Set(seen);
  visited.add(node.id);

  for (const ancestorId of node.provenance) {
    const ancestor = lookup(ancestorId);
    if (ancestor === undefined) return false;
    if (!isAiSafe(ancestor, lookup, visited)) return false;
  }

  return true;
}

/**
 * @throws ProvenanceViolationError when `candidate` is not AI-safe. The caller (an AI serializer,
 * an AIContextBuilder) is meant to let this exception propagate rather than catch and continue --
 * `assert*` naming signals that on purpose.
 */
export function assertAiSafe(candidate: unknown, lookup: ProvenanceLookup, nodeId: NodeId): void {
  if (!isAiSafe(candidate, lookup)) {
    throw new ProvenanceViolationError(
      `Node "${nodeId}" is not AI-safe: fails schema validation, its own policy is not ALLOW, ` +
        'an ancestor could not be resolved, or a cycle was detected. ai_safe(value) requires ALL ' +
        'provenance ancestors to be AI_ALLOW (TDD §7.2).',
      nodeId,
    );
  }
}

/**
 * A `SourceEvent` is the root of the DAG (TDD §7): it has no further ancestors, and its own
 * `ai_policy` comes from the resolved `source_policies` row for its `source` field, never from a
 * caller-supplied literal -- `NormalizedEvent` carries no `ai_policy` of its own, by design
 * (ADR-004). Cross-checks `event.source` against the resolved policy row's own `source` before
 * trusting it, closing the structural gap where a mismatched source_policy_id could otherwise
 * smuggle in the wrong source's policy.
 */
export function sourceEventNode(
  eventId: NodeId,
  event: { source: Source; source_policy_id: string },
  resolvePolicy: SourcePolicyLookup,
): SourceEventNode {
  const policy = resolvePolicy(event.source_policy_id);
  if (!policy) {
    throw new ProvenanceViolationError(
      `source_policy_id "${event.source_policy_id}" does not resolve to a known policy row`,
      eventId,
    );
  }
  if (policy.source !== event.source) {
    throw new ProvenanceViolationError(
      `event.source ("${event.source}") does not match its resolved policy's source ` +
        `("${policy.source}")`,
      eventId,
    );
  }
  return SourceEventNodeSchema.parse({
    kind: 'SOURCE_EVENT',
    id: eventId,
    source: event.source,
    ai_policy: policy.ai_policy,
    provenance: [],
  });
}
