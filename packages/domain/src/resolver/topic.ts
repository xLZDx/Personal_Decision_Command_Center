export type TopicResolution = 'AUTO_ATTACH' | 'CANDIDATE_MERGE' | 'SEPARATE' | 'UNKNOWN';

export interface TopicCandidate {
  projectId?: string;
  streamId?: string;
  businessIdentifier?: string;
  confirmedParticipant?: string;
  intentClass?: string;
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

/** Deterministic cross-channel resolver. It accepts metadata only, never source bodies. */
export function resolveTopicDeterministically(
  left: TopicCandidate,
  right: TopicCandidate,
): TopicResolutionResult {
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
  if (left.projectId && left.projectId === right.projectId) {
    score += 0.25;
    reasons.push('same confirmed project');
  }
  if (left.streamId && left.streamId === right.streamId) {
    score += 0.25;
    reasons.push('same confirmed stream');
  }
  if (left.businessIdentifier && left.businessIdentifier === right.businessIdentifier) {
    score += 0.35;
    reasons.push('same namespaced business identifier');
  }
  if (left.confirmedParticipant && left.confirmedParticipant === right.confirmedParticipant) {
    score += 0.05;
    reasons.push('same confirmed participant');
  }
  if (left.intentClass && left.intentClass === right.intentClass) {
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
