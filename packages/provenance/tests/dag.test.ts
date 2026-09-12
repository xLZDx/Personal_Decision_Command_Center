import { describe, expect, it } from 'vitest';

import {
  ProvenanceViolationError,
  assertAiSafe,
  isAiSafe,
  nodeFromProvenanceValue,
  sourceEventNode,
  type ProvenanceLookup,
  type ProvenanceNode,
} from '../src/dag.js';

function lookupFrom(nodes: ProvenanceNode[]): ProvenanceLookup {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (id) => byId.get(id);
}

describe('isAiSafe', () => {
  it('is true for a leaf node with ai_policy ALLOW and no ancestors (STATIC_CONFIG case)', () => {
    const node: ProvenanceNode = { id: 'v1', ai_policy: 'ALLOW', provenance: [] };
    expect(isAiSafe(node, lookupFrom([]))).toBe(true);
  });

  it('is false when the node itself is DENY, regardless of ancestry', () => {
    const node: ProvenanceNode = { id: 'v1', ai_policy: 'DENY', provenance: [] };
    expect(isAiSafe(node, lookupFrom([]))).toBe(false);
  });

  it('is true when every ancestor, transitively, is ALLOW', () => {
    const root = sourceEventNode('gmail-event-1', 'ALLOW');
    const value: ProvenanceNode = { id: 'v1', ai_policy: 'ALLOW', provenance: ['gmail-event-1'] };
    expect(isAiSafe(value, lookupFrom([root]))).toBe(true);
  });

  it('is false when a single ancestor deep in the chain is DENY (raw Telegram -> AI BLOCKED)', () => {
    const root = sourceEventNode('telegram-event-1', 'DENY');
    const enrichment: ProvenanceNode = {
      id: 'e1',
      ai_policy: 'ALLOW',
      provenance: ['telegram-event-1'],
    };
    const assignment: ProvenanceNode = { id: 'a1', ai_policy: 'ALLOW', provenance: ['e1'] };
    expect(isAiSafe(assignment, lookupFrom([root, enrichment]))).toBe(false);
  });

  it('is false for mixed ancestry: one ALLOW ancestor and one DENY ancestor', () => {
    const gmailRoot = sourceEventNode('gmail-1', 'ALLOW');
    const telegramRoot = sourceEventNode('telegram-1', 'DENY');
    const combined: ProvenanceNode = {
      id: 'combined',
      ai_policy: 'ALLOW',
      provenance: ['gmail-1', 'telegram-1'],
    };
    expect(isAiSafe(combined, lookupFrom([gmailRoot, telegramRoot]))).toBe(false);
  });

  it('is false for unknown ancestry: an ancestor id the lookup cannot resolve', () => {
    const node: ProvenanceNode = { id: 'v1', ai_policy: 'ALLOW', provenance: ['missing-ancestor'] };
    expect(isAiSafe(node, lookupFrom([]))).toBe(false);
  });

  it('is false for a cycle, and does not loop forever', () => {
    const a: ProvenanceNode = { id: 'a', ai_policy: 'ALLOW', provenance: ['b'] };
    const b: ProvenanceNode = { id: 'b', ai_policy: 'ALLOW', provenance: ['a'] };
    expect(isAiSafe(a, lookupFrom([a, b]))).toBe(false);
  });

  it('is true for a GmailEvidenceBundle-shaped chain with Gmail-only eligible ancestry', () => {
    const gmailEvent = sourceEventNode('gmail-msg-1', 'ALLOW');
    const enrichment: ProvenanceNode = {
      id: 'gmail-enrichment-1',
      ai_policy: 'ALLOW',
      provenance: ['gmail-msg-1'],
    };
    const evidence: ProvenanceNode = {
      id: 'evidence-bundle-1',
      ai_policy: 'ALLOW',
      provenance: ['gmail-enrichment-1'],
    };
    expect(isAiSafe(evidence, lookupFrom([gmailEvent, enrichment]))).toBe(true);
  });

  it('is false for a combined Gmail+Telegram Topic, even when the Topic node itself says ALLOW', () => {
    const gmailEvent = sourceEventNode('gmail-1', 'ALLOW');
    const telegramEvent = sourceEventNode('telegram-1', 'DENY');
    const topic: ProvenanceNode = {
      id: 'topic-1',
      ai_policy: 'ALLOW',
      provenance: ['gmail-1', 'telegram-1'],
    };
    expect(isAiSafe(topic, lookupFrom([gmailEvent, telegramEvent]))).toBe(false);
  });
});

describe('assertAiSafe', () => {
  it('does not throw for an AI-safe node', () => {
    const node: ProvenanceNode = { id: 'v1', ai_policy: 'ALLOW', provenance: [] };
    expect(() => assertAiSafe(node, lookupFrom([]))).not.toThrow();
  });

  it('throws ProvenanceViolationError, naming the node id, for a DENY node', () => {
    const node: ProvenanceNode = { id: 'telegram-derived', ai_policy: 'DENY', provenance: [] };
    try {
      assertAiSafe(node, lookupFrom([]));
      expect.unreachable('assertAiSafe must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ProvenanceViolationError);
      expect((error as ProvenanceViolationError).nodeId).toBe('telegram-derived');
    }
  });

  it('throws for unknown ancestry, not just for an explicit DENY', () => {
    const node: ProvenanceNode = { id: 'v1', ai_policy: 'ALLOW', provenance: ['unresolved'] };
    expect(() => assertAiSafe(node, lookupFrom([]))).toThrow(ProvenanceViolationError);
  });
});

describe('nodeFromProvenanceValue', () => {
  it('carries the ai_policy and provenance ids through unchanged', () => {
    const node = nodeFromProvenanceValue('hint-0', {
      ai_policy: 'DENY',
      provenance: ['telegram-event-9'],
    });
    expect(node).toEqual({ id: 'hint-0', ai_policy: 'DENY', provenance: ['telegram-event-9'] });
  });

  it('does not alias the caller-supplied provenance array', () => {
    const source = { ai_policy: 'ALLOW' as const, provenance: ['a'] };
    const node = nodeFromProvenanceValue('v', source);
    source.provenance.push('b');
    expect(node.provenance).toEqual(['a']);
  });
});

describe('sourceEventNode', () => {
  it('produces a leaf node with no ancestors', () => {
    expect(sourceEventNode('evt-1', 'ALLOW')).toEqual({
      id: 'evt-1',
      ai_policy: 'ALLOW',
      provenance: [],
    });
  });
});
