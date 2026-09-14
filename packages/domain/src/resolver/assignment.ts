import { z } from 'zod';
import { SourceSchema, type Source } from '@pdos/contracts';

import {
  resolveTopicDeterministically,
  type TopicCandidate,
  type TopicResolutionResult,
} from './topic.js';

const NamespacedIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^:\s]+::[^:\s].*$/, 'businessIdentifier must be namespaced as namespace::value');

const TopicCandidateSchema = z
  .object({
    projectId: z.string().min(1).max(256).optional(),
    projectConfirmed: z.boolean().optional(),
    streamId: z.string().min(1).max(256).optional(),
    streamConfirmed: z.boolean().optional(),
    businessIdentifier: NamespacedIdentifierSchema.optional(),
    businessIdentifierConfirmed: z.boolean().optional(),
    confirmedParticipant: z.string().min(1).max(256).optional(),
    participantConfirmed: z.boolean().optional(),
    intentClass: z.string().min(1).max(128).optional(),
    intentConfirmed: z.boolean().optional(),
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

const EventIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
    { message: 'eventId must not contain control characters' },
  );

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
  const evidenceIds = [EventIdSchema.parse(left.eventId), EventIdSchema.parse(right.eventId)];
  const sources = [SourceSchema.parse(left.source), SourceSchema.parse(right.source)];
  return {
    resolution: resolveTopicDeterministically(leftCandidate, rightCandidate),
    evidenceIds,
    sources,
    crossChannel: sources.length > 1,
  };
}
