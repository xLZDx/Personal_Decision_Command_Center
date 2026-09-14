import { z } from 'zod';

const Id = z.string().min(1).max(256);
const Evidence = z.array(Id).min(1).max(32);

export const DecisionSchema = z
  .object({
    decisionId: Id,
    title: z.string().trim().min(1).max(256),
    recommendation: z.string().trim().min(1).max(1024),
    priority: z.number().int().min(1).max(5),
    evidenceIds: Evidence,
    aiPolicy: z.enum(['ALLOW', 'DENY']),
    telegramEvidenceIds: z.array(Id).max(32).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.aiPolicy === 'DENY' && value.telegramEvidenceIds.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['telegramEvidenceIds'],
        message: 'Telegram evidence cannot enter an AI-denied decision context',
      });
    }
  });

export type Decision = z.infer<typeof DecisionSchema>;

export function validateDecision(input: unknown): Decision {
  return DecisionSchema.parse(input);
}

export const COMMITMENT_STATES = ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'] as const;
export type CommitmentState = (typeof COMMITMENT_STATES)[number];
const commitmentTransitions: Record<CommitmentState, readonly CommitmentState[]> = {
  OPEN: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['BLOCKED', 'DONE', 'CANCELLED'],
  BLOCKED: ['IN_PROGRESS', 'CANCELLED'],
  DONE: [],
  CANCELLED: [],
};

export function transitionCommitment(from: CommitmentState, to: CommitmentState): CommitmentState {
  if (!COMMITMENT_STATES.includes(from) || !COMMITMENT_STATES.includes(to)) {
    throw new Error('unknown commitment state');
  }
  if (!commitmentTransitions[from].includes(to)) {
    throw new Error(`invalid commitment transition ${from} -> ${to}`);
  }
  return to;
}

export const MILESTONE_STATES = ['PLANNED', 'IN_PROGRESS', 'BLOCKED', 'DONE'] as const;
export type MilestoneState = (typeof MILESTONE_STATES)[number];
const milestoneTransitions: Record<MilestoneState, readonly MilestoneState[]> = {
  PLANNED: ['IN_PROGRESS'],
  IN_PROGRESS: ['BLOCKED', 'DONE'],
  BLOCKED: ['IN_PROGRESS'],
  DONE: [],
};

export function transitionMilestone(from: MilestoneState, to: MilestoneState): MilestoneState {
  if (!MILESTONE_STATES.includes(from) || !MILESTONE_STATES.includes(to)) {
    throw new Error('unknown milestone state');
  }
  if (!milestoneTransitions[from].includes(to)) {
    throw new Error(`invalid milestone transition ${from} -> ${to}`);
  }
  return to;
}

export function explainPriority(priority: number): string {
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
    throw new Error('priority must be an integer from 1 to 5');
  }
  return (
    {
      1: 'critical: immediate user or safety impact',
      2: 'high: important near-term outcome',
      3: 'normal: planned work',
      4: 'low: useful but deferrable',
      5: 'backlog: no near-term commitment',
    } as const
  )[priority as 1 | 2 | 3 | 4 | 5];
}
