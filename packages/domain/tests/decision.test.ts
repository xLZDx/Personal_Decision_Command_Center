import { describe, expect, it } from 'vitest';

import {
  explainPriority,
  transitionCommitment,
  transitionMilestone,
  validateDecision,
} from '../src/index.js';

describe('G6 decision and state primitives', () => {
  it('requires evidence and rejects Telegram evidence in AI-denied context', () => {
    expect(() =>
      validateDecision({
        decisionId: 'd1',
        title: 'Ship',
        recommendation: 'yes',
        priority: 2,
        evidenceIds: [],
        aiPolicy: 'DENY',
      }),
    ).toThrow();
    expect(() =>
      validateDecision({
        decisionId: 'd1',
        title: 'Ship',
        recommendation: 'yes',
        priority: 2,
        evidenceIds: ['e1'],
        aiPolicy: 'DENY',
        telegramEvidenceIds: ['e1'],
      }),
    ).toThrow();
    expect(
      validateDecision({
        decisionId: 'd1',
        title: 'Ship',
        recommendation: 'yes',
        priority: 2,
        evidenceIds: ['e1'],
        aiPolicy: 'DENY',
      }).telegramEvidenceIds,
    ).toEqual([]);
  });

  it('enforces commitment and milestone state machines', () => {
    expect(transitionCommitment('OPEN', 'IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(() => transitionCommitment('DONE', 'OPEN')).toThrow();
    expect(transitionMilestone('PLANNED', 'IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(() => transitionMilestone('DONE', 'BLOCKED')).toThrow();
  });

  it('provides explainable bounded priority', () => {
    expect(explainPriority(1)).toContain('critical');
    expect(() => explainPriority(6)).toThrow();
  });
});
