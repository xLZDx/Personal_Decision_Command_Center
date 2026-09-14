import { describe, expect, it } from 'vitest';

import { resolveIdentityDeterministically } from '../../src/index.js';

describe('resolveIdentityDeterministically', () => {
  it('uses an exact operator mapping and preserves evidence IDs', () => {
    expect(
      resolveIdentityDeterministically({ source: 'telegram', sourceIdentity: 'tg:123' }, [
        {
          source: 'telegram',
          sourceIdentity: 'tg:123',
          personId: 'person-1',
          state: 'CONFIRMED',
          evidenceIds: ['mapping-1'],
        },
      ]),
    ).toEqual({ state: 'CONFIRMED', personId: 'person-1', evidenceIds: ['mapping-1'] });
  });

  it('does not merge by display-name coincidence and fails closed on conflicts', () => {
    expect(
      resolveIdentityDeterministically({ source: 'telegram', sourceIdentity: 'tg:unknown' }, [
        {
          source: 'telegram',
          sourceIdentity: 'tg:someone-else',
          personId: 'person-1',
          state: 'CONFIRMED',
          evidenceIds: ['name-only'],
        },
      ]).state,
    ).toBe('UNKNOWN');
    expect(
      resolveIdentityDeterministically({ source: 'gmail', sourceIdentity: 'alex@example.com' }, [
        {
          source: 'gmail',
          sourceIdentity: 'alex@example.com',
          personId: 'person-1',
          state: 'CONFIRMED',
          evidenceIds: ['a'],
        },
        {
          source: 'gmail',
          sourceIdentity: 'alex@example.com',
          personId: 'person-2',
          state: 'CONFIRMED',
          evidenceIds: ['b'],
        },
      ]),
    ).toEqual({ state: 'UNKNOWN', personId: null, evidenceIds: [] });
    expect(
      resolveIdentityDeterministically({ source: 'telegram', sourceIdentity: 'tg:blocked' }, [
        {
          source: 'telegram',
          sourceIdentity: 'tg:blocked',
          personId: 'person-1',
          state: 'REJECTED',
          evidenceIds: ['reject-1'],
        },
      ]),
    ).toEqual({ state: 'REJECTED', personId: null, evidenceIds: ['reject-1'] });
  });

  it('rejects runtime-invalid candidate and mapping fields', () => {
    expect(() =>
      resolveIdentityDeterministically({ source: 'telegram', sourceIdentity: 'tg:1' }, [
        {
          source: 'signal' as never,
          sourceIdentity: 'tg:1',
          personId: 'person-1',
          state: 'CONFIRMED',
          evidenceIds: ['e1'],
        },
      ]),
    ).toThrow();
  });
});
