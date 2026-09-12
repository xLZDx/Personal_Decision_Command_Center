/**
 * Provenance DAG traversal and the `ai_safe()` composition rule (ADR-005, TDD §7.2).
 *
 * This module is the "testable primitive" ADR-005 requires, not documentation: `packages/policy`
 * or a future AI serializer calls `assertAiSafe()` and gets a thrown error, not a comment telling
 * a human to check something.
 *
 * The graph: `SourceEvent -> ProvenanceValue/ProvenanceAssignment -> SourceEnrichment ->
 * TopicAssignment/DecisionEvidence -> Decision/Commitment/Milestone` (TDD §7). Every node in that
 * chain is modeled here as a `ProvenanceNode`: its own `ai_policy`, plus the ids of the nodes it
 * was derived from. A `SourceEvent` is a LEAF node (no further ancestors) whose `ai_policy` comes
 * from the resolved `source_policies` row for its `source` -- see `sourceEventNode()`.
 *
 * Composition rule (TDD §7.2, verbatim): "ai_safe(value) = all provenance ancestors are AI_ALLOW.
 * Unknown/mixed ancestry = AI_DENY." Three distinct fail-closed cases, each deliberate:
 *
 * 1. The node's own `ai_policy` is DENY -> DENY, regardless of ancestry.
 * 2. Any ancestor id the lookup cannot resolve ("unknown ancestry") -> DENY. A caller that has not
 *    yet loaded the full ancestor chain must never be able to make that look like "no restricted
 *    ancestors" by returning `undefined` and having the traversal shrug it off.
 * 3. A cycle (a node reachable from itself) -> DENY. A DAG should never contain one, but a bug
 *    producing one must never resolve to an infinite loop, and must never resolve to ALLOW either
 *    -- both would be worse than a loud, safe refusal.
 */

export type NodeId = string;

export type AiPolicy = 'ALLOW' | 'DENY';

export interface ProvenanceNode {
  id: NodeId;
  ai_policy: AiPolicy;
  /** Ids of the nodes this one was derived from. Empty for a genuine root (STATIC_CONFIG-derived
   *  values with no source ancestry at all) -- never used to represent "ancestry not loaded yet",
   *  which must instead be represented by the lookup returning `undefined` for that id. */
  provenance: NodeId[];
}

export type ProvenanceLookup = (id: NodeId) => ProvenanceNode | undefined;

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
 * @returns true only if `node` and every transitive ancestor resolve to AI_ALLOW. Fails closed
 * (returns false) on a DENY node, an unresolved ancestor id, or a cycle.
 */
export function isAiSafe(
  node: ProvenanceNode,
  lookup: ProvenanceLookup,
  seen: Set<NodeId> = new Set(),
): boolean {
  if (node.ai_policy === 'DENY') return false;
  if (seen.has(node.id)) return false;

  const visited = new Set(seen);
  visited.add(node.id);

  for (const ancestorId of node.provenance) {
    const ancestor = lookup(ancestorId);
    if (!ancestor) return false;
    if (!isAiSafe(ancestor, lookup, visited)) return false;
  }

  return true;
}

/**
 * @throws ProvenanceViolationError when `node` is not AI-safe. The caller (an AI serializer, an
 * AIContextBuilder) is meant to let this exception propagate rather than catch and continue --
 * `assert*` naming signals that on purpose.
 */
export function assertAiSafe(node: ProvenanceNode, lookup: ProvenanceLookup): void {
  if (!isAiSafe(node, lookup)) {
    throw new ProvenanceViolationError(
      `Node "${node.id}" is not AI-safe: its own policy is DENY, an ancestor is DENY, an ` +
        'ancestor could not be resolved (unknown ancestry), or a cycle was detected. ' +
        'ai_safe(value) requires ALL provenance ancestors to be AI_ALLOW (TDD §7.2).',
      node.id,
    );
  }
}

/**
 * Adapts a `ProvenanceValue` (packages/contracts) into a graph node. `ProvenanceValue.provenance`
 * is a list of source-event ids -- the leaves this node's `provenance` array points at are
 * resolved via `sourceEventNode()` (or a further `ProvenanceValue`, if the lookup composes them).
 */
export function nodeFromProvenanceValue(
  id: NodeId,
  pv: { ai_policy: AiPolicy; provenance: string[] },
): ProvenanceNode {
  return { id, ai_policy: pv.ai_policy, provenance: [...pv.provenance] };
}

/**
 * A `SourceEvent` is the root of the DAG (TDD §7): it has no further ancestors, and its own
 * `ai_policy` comes from the resolved `source_policies` row for its `source` field, never from a
 * field on the event itself -- `NormalizedEvent` carries no `ai_policy`, by design (ADR-004).
 */
export function sourceEventNode(eventId: NodeId, sourceAiPolicy: AiPolicy): ProvenanceNode {
  return { id: eventId, ai_policy: sourceAiPolicy, provenance: [] };
}
