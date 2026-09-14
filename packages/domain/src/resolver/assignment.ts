import { z } from 'zod';
import type { Source } from '@pdos/contracts';

import {
  resolveTopicDeterministically,
  type TopicCandidate,
  type TopicResolutionResult,
} from './topic.js';

const TopicCandidateSchema = z
  .object({
    projectId: z.string().min(1).max(256).optional(),
    streamId: z.string().min(1).max(256).optional(),
    businessIdentifier: z.string().min(1).max(256).optional(),
    confirmedParticipant: z.string().min(1).max(256).optional(),
    intentClass: z.string().min(1).max(128).optional(),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    confirmedProjectConflict: z.boolean().optional(),
    keepSeparate: z.boolean().optional(),
    explicitMerge: z.boolean().optional(),
  })
  .strict();

export interface TopicAssignmentEvidence {
  eventId: string;
  source: Source;
  candidate: TopicCandidate;
}

export interface TopicAssignmentAudit {
  resolution: TopicResolutionResult;
  evidenceIds: readonly string[];
  sources: readonly Source[];
  crossChannel: boolean;
}

/**
 * Runtime-checked cross-channel assignment boundary. Only bounded resolver metadata is accepted;
 * extra fields (including body/text/title) fail before assignment. The audit keeps source/event
 * ancestry explicit so a later caller cannot mistake a topic merge for AI-safe source evidence.
 */
export function assignTopicDeterministically(
  left: TopicAssignmentEvidence,
  right: TopicAssignmentEvidence,
): TopicAssignmentAudit {
  const leftCandidate = TopicCandidateSchema.parse(left.candidate) as TopicCandidate;
  const rightCandidate = TopicCandidateSchema.parse(right.candidate) as TopicCandidate;
  const evidenceIds = [...new Set([left.eventId, right.eventId])];
  const sources = [...new Set([left.source, right.source])];
  return {
    resolution: resolveTopicDeterministically(leftCandidate, rightCandidate),
    evidenceIds,
    sources,
    crossChannel: sources.length > 1,
  };
}
