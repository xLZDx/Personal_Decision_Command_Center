import type { Source } from '@pdos/contracts';

export const IDENTITY_STATES = ['CONFIRMED', 'SUGGESTED', 'REJECTED'] as const;
export type IdentityState = (typeof IDENTITY_STATES)[number];

export interface IdentityMapping {
  source: Source;
  sourceIdentity: string;
  personId: string;
  state: IdentityState;
  evidenceIds: readonly string[];
}

export interface IdentityCandidate {
  source: Source;
  sourceIdentity: string;
}

export type IdentityResolution =
  | {
      state: 'CONFIRMED' | 'SUGGESTED' | 'REJECTED';
      personId: string;
      evidenceIds: readonly string[];
    }
  | { state: 'UNKNOWN'; personId: null; evidenceIds: readonly string[] };

/**
 * Resolves only an exact operator/configured identity mapping. Display names and source text are
 * deliberately absent from the input, so a spelling coincidence can never become an irreversible
 * person merge. Conflicting exact mappings fail closed as UNKNOWN.
 */
export function resolveIdentityDeterministically(
  candidate: IdentityCandidate,
  mappings: readonly IdentityMapping[],
): IdentityResolution {
  const matches = mappings.filter(
    (mapping) =>
      mapping.source === candidate.source && mapping.sourceIdentity === candidate.sourceIdentity,
  );
  const personIds = new Set(matches.map((mapping) => mapping.personId));
  if (personIds.size !== 1 || matches.length === 0) {
    return { state: 'UNKNOWN', personId: null, evidenceIds: [] };
  }
  const [personId] = personIds;
  if (!personId) return { state: 'UNKNOWN', personId: null, evidenceIds: [] };
  const strongest =
    matches.find((mapping) => mapping.state === 'CONFIRMED') ??
    matches.find((mapping) => mapping.state === 'SUGGESTED') ??
    matches[0];
  if (!strongest) return { state: 'UNKNOWN', personId: null, evidenceIds: [] };
  return {
    state: strongest.state,
    personId,
    evidenceIds: [...new Set(matches.flatMap((mapping) => mapping.evidenceIds))],
  };
}
