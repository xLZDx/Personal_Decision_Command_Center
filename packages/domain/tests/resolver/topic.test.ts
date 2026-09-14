import { describe, expect, it } from 'vitest';

import { resolveTopicDeterministically } from '../../src/index.js';

describe('resolveTopicDeterministically', () => {
  it('auto-attaches only when deterministic strong signals reach threshold', () => {
    const result = resolveTopicDeterministically(
      {
        projectId: 'erp',
        streamId: 'release',
        businessIdentifier: 'ERP::Gate-4.2',
        confirmedParticipant: 'p1',
        intentClass: 'ACTION_REQUIRED',
        occurredAt: '2026-09-14T10:00:00.000Z',
      },
      {
        projectId: 'erp',
        streamId: 'release',
        businessIdentifier: 'ERP::Gate-4.2',
        confirmedParticipant: 'p1',
        intentClass: 'ACTION_REQUIRED',
        occurredAt: '2026-09-14T11:00:00.000Z',
      },
    );
    expect(result.resolution).toBe('AUTO_ATTACH');
    expect(result.score).toBe(1);
  });

  it('hard barriers override every score and unknown does not invent a project', () => {
    expect(
      resolveTopicDeterministically(
        { projectId: 'a', businessIdentifier: 'ERP::1', confirmedProjectConflict: true },
        { projectId: 'a', businessIdentifier: 'ERP::1' },
      ).resolution,
    ).toBe('SEPARATE');
    expect(resolveTopicDeterministically({}, {}).resolution).toBe('UNKNOWN');
  });

  it('treats differing project IDs as a hard barrier even when all other signals match', () => {
    expect(
      resolveTopicDeterministically(
        {
          projectId: 'project-a',
          streamId: 'release',
          businessIdentifier: 'ERP::Gate-4.2',
          explicitMerge: true,
        },
        {
          projectId: 'project-b',
          streamId: 'release',
          businessIdentifier: 'ERP::Gate-4.2',
        },
      ).resolution,
    ).toBe('SEPARATE');
  });
});
