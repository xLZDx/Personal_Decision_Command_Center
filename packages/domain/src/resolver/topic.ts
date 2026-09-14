import { z } from 'zod';

export type TopicResolution = 'AUTO_ATTACH' | 'CANDIDATE_MERGE' | 'SEPARATE' | 'UNKNOWN';

export interface TopicCandidate {
  projectId?: string;
  projectConfirmed?: boolean;
  streamId?: string;
  streamConfirmed?: boolean;
  businessIdentifier?: string;
  businessIdentifierConfirmed?: boolean;
  confirmedParticipant?: string;
  participantConfirmed?: boolean;
  intentClass?: string;
  intentConfirmed?: boolean;
  occurredAt?: string;
  confirmedProjectConflict?: boolean;
  keepSeparate?: boolean;
  explicitMerge?: boolean;
}

export interface TopicResolutionResult {
  resolution: TopicResolution;
  score: number;
  reasons: readonly string[];
}

const TopicCandidateSchema = z
  .object({
    projectId: z.string().min(1).max(256).optional(),
    projectConfirmed: z.boolean().optional(),
    streamId: z.string().min(1).max(256).optional(),
    streamConfirmed: z.boolean().optional(),
    businessIdentifier: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^:\s]+::[^:\s].*$/, 'businessIdentifier must be namespaced')
      .optional(),
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

function parseCandidate(candidate: TopicCandidate): TopicCandidate | null {
  const parsed = TopicCandidateSchema.safeParse(candidate);
  return parsed.success ? (parsed.data as TopicCandidate) : null;
}

/** Deterministic cross-channel resolver. It accepts metadata only, never source bodies. */
export function resolveTopicDeterministically(
  left: TopicCandidate,
  right: TopicCandidate,
): TopicResolutionResult {
  const parsedLeft = parseCandidate(left);
  const parsedRight = parseCandidate(right);
  if (parsedLeft === null || parsedRight === null) {
    return { resolution: 'UNKNOWN', score: 0, reasons: ['invalid candidate metadata'] };
  }
  left = parsedLeft;
  right = parsedRight;
  if (
    (left.projectId && right.projectId && left.projectId !== right.projectId) ||
    left.keepSeparate ||
    right.keepSeparate ||
    left.confirmedProjectConflict ||
    right.confirmedProjectConflict
  ) {
    return { resolution: 'SEPARATE', score: 0, reasons: ['hard barrier'] };
  }
  if (left.explicitMerge || right.explicitMerge) {
    return { resolution: 'AUTO_ATTACH', score: 1, reasons: ['explicit user merge'] };
  }
  let score = 0;
  const reasons: string[] = [];
  if (
    left.projectConfirmed === true &&
    right.projectConfirmed === true &&
    left.projectId &&
    left.projectId === right.projectId
  ) {
    score += 0.25;
    reasons.push('same confirmed project');
  }
  if (
    left.streamConfirmed === true &&
    right.streamConfirmed === true &&
    left.streamId &&
    left.streamId === right.streamId
  ) {
    score += 0.25;
    reasons.push('same confirmed stream');
  }
  if (
    left.businessIdentifierConfirmed === true &&
    right.businessIdentifierConfirmed === true &&
    left.businessIdentifier &&
    left.businessIdentifier === right.businessIdentifier
  ) {
    score += 0.35;
    reasons.push('same namespaced business identifier');
  }
  if (
    left.participantConfirmed === true &&
    right.participantConfirmed === true &&
    left.confirmedParticipant &&
    left.confirmedParticipant === right.confirmedParticipant
  ) {
    score += 0.05;
    reasons.push('same confirmed participant');
  }
  if (
    left.intentConfirmed === true &&
    right.intentConfirmed === true &&
    left.intentClass &&
    left.intentClass === right.intentClass
  ) {
    score += 0.05;
    reasons.push('same deterministic intent class');
  }
  if (left.occurredAt && right.occurredAt) {
    const delta = Math.abs(Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
    if (Number.isFinite(delta) && delta <= 24 * 60 * 60 * 1000) {
      score += 0.05;
      reasons.push('within time window');
    }
  }
  if (score === 0) return { resolution: 'UNKNOWN', score, reasons };
  return {
    resolution: score >= 0.9 ? 'AUTO_ATTACH' : score >= 0.7 ? 'CANDIDATE_MERGE' : 'SEPARATE',
    score: Number(score.toFixed(2)),
    reasons,
  };
}
