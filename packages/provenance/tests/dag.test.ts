import { describe, expect, it } from 'vitest';

import {
  ProvenanceViolationError,
  assertAiSafe,
  isAiSafe,
  makeDerivedNode,
  makeStaticConfigNode,
  sourceEventNode,
  type ProvenanceLookup,
  type ProvenanceNode,
} from '../src/dag.js';
import type { SourcePolicyLookup, SourcePolicyRecord } from '../src/source-policy.js';

function lookupFrom(nodes: ProvenanceNode[]): ProvenanceLookup {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (id) => byId.get(id);
}

function policyLookupFrom(records: SourcePolicyRecord[]): SourcePolicyLookup {
  const byId = new Map(records.map((r) => [r.source_policy_id, r]));
  return (id) => byId.get(id);
}

describe('isAiSafe', () => {
  it('is true for a STATIC_CONFIG leaf node with ai_policy ALLOW and no ancestors', () => {
    const node = makeStaticConfigNode('v1', 'ALLOW');
    expect(isAiSafe(node, lookupFrom([]))).toBe(true);
  });

  it('is false when the node itself is DENY, regardless of ancestry', () => {
    const node = makeStaticConfigNode('v1', 'DENY');
    expect(isAiSafe(node, lookupFrom([]))).toBe(false);
  });

  it('is true when every ancestor, transitively, is ALLOW', () => {
    const root = sourceEventNode(
      'gmail-event-1',
      { source: 'gmail', source_policy_id: 'p-gmail-allow' },
      policyLookupFrom([
        { source_policy_id: 'p-gmail-allow', source: 'gmail', ai_policy: 'ALLOW', version: 1 },
      ]),
    );
    const value = makeDerivedNode('v1', 'ALLOW', ['gmail-event-1']);
    expect(isAiSafe(value, lookupFrom([root]))).toBe(true);
  });

  it('is false when a single ancestor deep in the chain is DENY (raw Telegram -> AI BLOCKED)', () => {
    const root = sourceEventNode(
      'telegram-event-1',
      { source: 'telegram', source_policy_id: 'p-telegram-deny' },
      policyLookupFrom([
        { source_policy_id: 'p-telegram-deny', source: 'telegram', ai_policy: 'DENY', version: 1 },
      ]),
    );
    const enrichment = makeDerivedNode('e1', 'ALLOW', ['telegram-event-1']);
    const assignment = makeDerivedNode('a1', 'ALLOW', ['e1']);
    expect(isAiSafe(assignment, lookupFrom([root, enrichment]))).toBe(false);
  });

  it('is false for mixed ancestry: one ALLOW ancestor and one DENY ancestor', () => {
    const gmailRoot = sourceEventNode(
      'gmail-1',
      { source: 'gmail', source_policy_id: 'p-gmail' },
      policyLookupFrom([
        { source_policy_id: 'p-gmail', source: 'gmail', ai_policy: 'ALLOW', version: 1 },
      ]),
    );
    const telegramRoot = sourceEventNode(
      'telegram-1',
      { source: 'telegram', source_policy_id: 'p-telegram' },
      policyLookupFrom([
        { source_policy_id: 'p-telegram', source: 'telegram', ai_policy: 'DENY', version: 1 },
      ]),
    );
    const combined = makeDerivedNode('combined', 'ALLOW', ['gmail-1', 'telegram-1']);
    expect(isAiSafe(combined, lookupFrom([gmailRoot, telegramRoot]))).toBe(false);
  });

  it('is false for unknown ancestry: an ancestor id the lookup cannot resolve', () => {
    const node = makeDerivedNode('v1', 'ALLOW', ['missing-ancestor']);
    expect(isAiSafe(node, lookupFrom([]))).toBe(false);
  });

  it('is false for a cycle, and does not loop forever', () => {
    const a = makeDerivedNode('a', 'ALLOW', ['b']);
    const b = makeDerivedNode('b', 'ALLOW', ['a']);
    expect(isAiSafe(a, lookupFrom([a, b]))).toBe(false);
  });

  it('is true for a GmailEvidenceBundle-shaped chain with Gmail-only eligible ancestry', () => {
    const gmailEvent = sourceEventNode(
      'gmail-msg-1',
      { source: 'gmail', source_policy_id: 'p-gmail' },
      policyLookupFrom([
        { source_policy_id: 'p-gmail', source: 'gmail', ai_policy: 'ALLOW', version: 1 },
      ]),
    );
    const enrichment = makeDerivedNode('gmail-enrichment-1', 'ALLOW', ['gmail-msg-1']);
    const evidence = makeDerivedNode('evidence-bundle-1', 'ALLOW', ['gmail-enrichment-1']);
    expect(isAiSafe(evidence, lookupFrom([gmailEvent, enrichment]))).toBe(true);
  });

  it('is false for a combined Gmail+Telegram Topic, even when the Topic node itself says ALLOW', () => {
    const gmailEvent = sourceEventNode(
      'gmail-1',
      { source: 'gmail', source_policy_id: 'p-gmail' },
      policyLookupFrom([
        { source_policy_id: 'p-gmail', source: 'gmail', ai_policy: 'ALLOW', version: 1 },
      ]),
    );
    const telegramEvent = sourceEventNode(
      'telegram-1',
      { source: 'telegram', source_policy_id: 'p-telegram' },
      policyLookupFrom([
        { source_policy_id: 'p-telegram', source: 'telegram', ai_policy: 'DENY', version: 1 },
      ]),
    );
    const topic = makeDerivedNode('topic-1', 'ALLOW', ['gmail-1', 'telegram-1']);
    expect(isAiSafe(topic, lookupFrom([gmailEvent, telegramEvent]))).toBe(false);
  });

  it('is false for a candidate that fails schema validation entirely (wrong shape/unknown kind)', () => {
    expect(isAiSafe({ kind: 'NOT_A_REAL_KIND', id: 'x' }, lookupFrom([]))).toBe(false);
    expect(isAiSafe({ id: 'v1', ai_policy: 'ALLOW', provenance: [] }, lookupFrom([]))).toBe(false);
    expect(isAiSafe(null, lookupFrom([]))).toBe(false);
    expect(isAiSafe(undefined, lookupFrom([]))).toBe(false);
  });

  it('is false for a DERIVED node lookup result that itself fails validation (untyped ancestor)', () => {
    const node = makeDerivedNode('v1', 'ALLOW', ['bad-ancestor']);
    const lookup: ProvenanceLookup = (id) =>
      id === 'bad-ancestor' ? { kind: 'DERIVED', id: 'bad-ancestor' } : undefined;
    expect(isAiSafe(node, lookup)).toBe(false);
  });
});

describe('assertAiSafe', () => {
  it('does not throw for an AI-safe node', () => {
    const node = makeStaticConfigNode('v1', 'ALLOW');
    expect(() => assertAiSafe(node, lookupFrom([]), 'v1')).not.toThrow();
  });

  it('throws ProvenanceViolationError, naming the node id, for a DENY node', () => {
    const node = makeStaticConfigNode('telegram-derived', 'DENY');
    try {
      assertAiSafe(node, lookupFrom([]), 'telegram-derived');
      expect.unreachable('assertAiSafe must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ProvenanceViolationError);
      expect((error as ProvenanceViolationError).nodeId).toBe('telegram-derived');
    }
  });

  it('throws for unknown ancestry, not just for an explicit DENY', () => {
    const node = makeDerivedNode('v1', 'ALLOW', ['unresolved']);
    expect(() => assertAiSafe(node, lookupFrom([]), 'v1')).toThrow(ProvenanceViolationError);
  });
});

describe('makeStaticConfigNode / makeDerivedNode', () => {
  it('makeStaticConfigNode always produces zero ancestors', () => {
    const node = makeStaticConfigNode('cfg-1', 'ALLOW');
    expect(node).toEqual({
      kind: 'STATIC_CONFIG',
      id: 'cfg-1',
      ai_policy: 'ALLOW',
      provenance: [],
    });
  });

  it('makeDerivedNode requires at least one ancestor -- a DERIVED node cannot be a genuine root', () => {
    expect(() => makeDerivedNode('v1', 'ALLOW', [])).toThrow();
  });
});

describe('sourceEventNode', () => {
  it('resolves ai_policy from the source_policies row, not from a caller-supplied literal', () => {
    const node = sourceEventNode(
      'evt-1',
      { source: 'gmail', source_policy_id: 'p-gmail' },
      policyLookupFrom([
        { source_policy_id: 'p-gmail', source: 'gmail', ai_policy: 'ALLOW', version: 3 },
      ]),
    );
    expect(node).toEqual({
      kind: 'SOURCE_EVENT',
      id: 'evt-1',
      source: 'gmail',
      ai_policy: 'ALLOW',
      provenance: [],
    });
  });

  it('throws ProvenanceViolationError when source_policy_id does not resolve', () => {
    expect(() =>
      sourceEventNode('evt-1', { source: 'gmail', source_policy_id: 'missing' }, () => undefined),
    ).toThrow(ProvenanceViolationError);
  });

  it('throws ProvenanceViolationError when the resolved policy source does not match event.source', () => {
    expect(() =>
      sourceEventNode(
        'evt-1',
        { source: 'gmail', source_policy_id: 'p-telegram' },
        policyLookupFrom([
          { source_policy_id: 'p-telegram', source: 'telegram', ai_policy: 'DENY', version: 1 },
        ]),
      ),
    ).toThrow(ProvenanceViolationError);
  });
});
