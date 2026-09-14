import type { StringProvenanceValue } from '@pdos/contracts';

import { classifyTelegramIntent } from './intent.js';
import { parseTelegramDeterministically, type TelegramDeterministicSignal } from './parser.js';

export interface TelegramDeterministicEnrichment {
  source: 'telegram';
  eventId: string;
  intent: StringProvenanceValue;
  signals: readonly TelegramDeterministicSignal[];
  aiPolicy: 'DENY';
}

/**
 * Composes the two source-local deterministic passes without retaining the input body. Every
 * output value remains Telegram-tainted and AI-denied; callers may persist this metadata only
 * after applying their own retention policy.
 */
export function buildTelegramDeterministicEnrichment(input: {
  eventId: string;
  text: string;
  now: string;
}): TelegramDeterministicEnrichment {
  const intent = classifyTelegramIntent(input);
  const intentEvidence = intent.evidence[0];
  return {
    source: 'telegram',
    eventId: input.eventId,
    intent: intentEvidence
      ? { ...intentEvidence, value: intent.intent }
      : {
          value: intent.intent,
          provenance: [input.eventId],
          derivation_method: 'RULE',
          ai_policy: 'DENY',
          sensitivity: 'telegram-derived',
          created_at: input.now,
          derivation_version: 1,
        },
    signals: parseTelegramDeterministically(input),
    aiPolicy: 'DENY',
  };
}
