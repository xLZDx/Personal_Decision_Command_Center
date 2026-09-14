import { SourceSchema, type Source } from '@pdos/contracts';
import { z } from 'zod';

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

const IdentityCandidateSchema = z
  .object({ source: SourceSchema, sourceIdentity: z.string().min(1).max(256) })
  .strict();
const IdentityMappingSchema = z
  .object({
    source: SourceSchema,
    sourceIdentity: z.string().min(1).max(256),
    personId: z.string().min(1).max(256),
    state: z.enum(IDENTITY_STATES),
    evidenceIds: z.array(z.string().min(1).max(256)).max(16),
  })
  .strict();

export type IdentityResolution =
  | {
      state: 'CONFIRMED' | 'SUGGESTED';
      personId: string;
      evidenceIds: readonly string[];
    }
  | { state: 'REJECTED'; personId: null; evidenceIds: readonly string[] }
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
  const parsedCandidate = IdentityCandidateSchema.parse(candidate) as IdentityCandidate;
  const parsedMappings = mappings.map(
    (mapping) => IdentityMappingSchema.parse(mapping) as IdentityMapping,
  );
  const matches = parsedMappings.filter(
    (mapping) =>
      mapping.source === parsedCandidate.source &&
      mapping.sourceIdentity === parsedCandidate.sourceIdentity,
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
  if (matches.some((mapping) => mapping.state === 'REJECTED')) {
    return {
      state: 'REJECTED',
      personId: null,
      evidenceIds: [...new Set(matches.flatMap((mapping) => mapping.evidenceIds))],
    };
  }
  if (strongest.state === 'REJECTED') {
    return { state: 'REJECTED', personId: null, evidenceIds: [] };
  }
  return {
    state: strongest.state,
    personId,
    evidenceIds: [...new Set(matches.flatMap((mapping) => mapping.evidenceIds))],
  };
}
