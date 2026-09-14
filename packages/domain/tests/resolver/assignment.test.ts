import { describe, expect, it } from 'vitest';

import { assignTopicDeterministically } from '../../src/index.js';

describe('assignTopicDeterministically', () => {
  it('returns an auditable cross-channel result with only event evidence IDs', () => {
    const result = assignTopicDeterministically(
      {
        eventId: 'telegram-event-1',
        source: 'telegram',
        candidate: {
          projectId: 'erp',
          streamId: 'release',
          businessIdentifier: 'ERP::Gate-4.2',
        },
      },
      {
        eventId: 'gmail-event-1',
        source: 'gmail',
        candidate: {
          projectId: 'erp',
          streamId: 'release',
          businessIdentifier: 'ERP::Gate-4.2',
        },
      },
    );
    expect(result.resolution.resolution).toBe('CANDIDATE_MERGE');
    expect(result.evidenceIds).toEqual(['telegram-event-1', 'gmail-event-1']);
    expect(result.sources).toEqual(['telegram', 'gmail']);
    expect(result.crossChannel).toBe(true);
  });

  it('rejects raw-content fields at the assignment boundary', () => {
    expect(() =>
      assignTopicDeterministically(
        {
          eventId: 'telegram-event-2',
          source: 'telegram',
          candidate: { businessIdentifier: 'ERP::Gate-4.2', body: 'private text' } as never,
        },
        { eventId: 'gmail-event-2', source: 'gmail', candidate: {} },
      ),
    ).toThrow();
    expect(() =>
      assignTopicDeterministically(
        { eventId: 'event-3', source: 'telegram', candidate: { businessIdentifier: 'Gate-4.2' } },
        { eventId: 'event-4', source: 'gmail', candidate: {} },
      ),
    ).toThrow(/namespaced/);
  });
});
