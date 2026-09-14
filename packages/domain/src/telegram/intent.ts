import type { StringProvenanceValue } from '@pdos/contracts';

export const TELEGRAM_INTENT_CLASSES = [
  'DECISION_REQUIRED',
  'ACTION_REQUIRED',
  'WAITING_FOR_ME',
  'WAITING_FOR_OTHER',
  'BLOCKER',
  'DEADLINE',
  'DELIVERABLE_RECEIVED',
  'MILESTONE_UPDATE',
  'FYI',
  'UNKNOWN',
] as const;
export type TelegramIntentClass = (typeof TELEGRAM_INTENT_CLASSES)[number];

export interface TelegramIntentResult {
  intent: TelegramIntentClass;
  evidence: StringProvenanceValue[];
}

/** Priority-ordered deterministic intent mapping; Telegram ancestry is permanently AI_DENY. */
export function classifyTelegramIntent(input: {
  eventId: string;
  text: string;
  now: string;
}): TelegramIntentResult {
  const rules: readonly [TelegramIntentClass, RegExp][] = [
    ['BLOCKER', /\b(?:blocked|blocker|blocking)\b/i],
    ['DEADLINE', /\b(?:by|due)\s+\d{4}-\d{2}-\d{2}\b/i],
    ['WAITING_FOR_ME', /\b(?:need(?:s)?\s+your\s+input|waiting\s+for\s+your)\b/i],
    ['WAITING_FOR_OTHER', /\bwaiting\s+for\s+(?:them|other|vendor|client)\b/i],
    ['DECISION_REQUIRED', /\b(?:decide|decision|choose|choice)\b/i],
    ['ACTION_REQUIRED', /\b(?:please\s+)?(?:approve|review|send|do|action)\b/i],
    ['DELIVERABLE_RECEIVED', /\b(?:deliverable|attached|shipped|released)\b/i],
    ['MILESTONE_UPDATE', /\b(?:milestone|progress|status\s+update)\b/i],
  ];
  for (const [intent, rule] of rules) {
    const match = input.text.match(rule);
    if (!match) continue;
    return {
      intent,
      evidence: [
        {
          value: match[0],
          provenance: [input.eventId],
          derivation_method: 'RULE',
          ai_policy: 'DENY',
          sensitivity: 'telegram-derived',
          created_at: input.now,
          derivation_version: 1,
        },
      ],
    };
  }
  return { intent: 'FYI', evidence: [] };
}
