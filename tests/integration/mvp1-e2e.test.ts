import { describe, expect, it } from 'vitest';
import {
  assignTopicDeterministically,
  validateDecision,
  evaluateShadow,
  createOpaquePushPayload,
  decodeOpaquePushPayload,
} from '@pdos/domain';

describe('MVP1 production-equivalent metadata path', () => {
  it('links Gmail and Telegram metadata without sending combined state to AI or push', () => {
    const assignment = assignTopicDeterministically(
      {
        eventId: 'gmail-event-1',
        source: 'gmail',
        candidate: {
          projectId: 'erp',
          projectConfirmed: true,
          streamId: 'release',
          streamConfirmed: true,
          businessIdentifier: 'ERP::Gate-4.2',
          businessIdentifierConfirmed: true,
        },
      },
      {
        eventId: 'telegram-event-1',
        source: 'telegram',
        candidate: {
          projectId: 'erp',
          projectConfirmed: true,
          streamId: 'release',
          streamConfirmed: true,
          businessIdentifier: 'ERP::Gate-4.2',
          businessIdentifierConfirmed: true,
        },
      },
    );
    expect(assignment.crossChannel).toBe(true);
    expect(assignment.resolution.resolution).toBe('CANDIDATE_MERGE');
    expect(() =>
      validateDecision({
        decisionId: 'd-e2e',
        title: 'Gate',
        recommendation: 'review',
        priority: 2,
        evidenceIds: assignment.evidenceIds,
        aiPolicy: 'DENY',
        telegramEvidenceIds: assignment.evidenceIds.filter((_, i) => i === 1),
      }),
    ).toThrow();
    const push = decodeOpaquePushPayload(
      createOpaquePushPayload('00000000-0000-4000-8000-000000000901'),
    );
    expect(push).not.toHaveProperty('body');
  });

  it('produces deterministic shadow metrics from resolver labels', () => {
    expect(
      evaluateShadow([
        { id: 'gmail-event-1', expected: 'AUTO_ATTACH', actual: 'AUTO_ATTACH' },
        { id: 'telegram-event-1', expected: 'SEPARATE', actual: 'SEPARATE' },
      ]).accuracy,
    ).toBe(1);
  });
});
