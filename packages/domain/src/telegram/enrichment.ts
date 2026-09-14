import type { StringProvenanceValue } from '@pdos/contracts';

import { classifyTelegramIntent, type TelegramIntentClass } from './intent.js';
import { parseTelegramDeterministically, type TelegramDeterministicSignal } from './parser.js';

export interface TelegramDeterministicEnrichment {
  source: 'telegram';
  eventId: string;
  intent: TelegramIntentClass;
  intentEvidence: readonly StringProvenanceValue[];
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
  return {
    source: 'telegram',
    eventId: input.eventId,
    intent: intent.intent,
    intentEvidence: intent.evidence,
    signals: parseTelegramDeterministically(input),
    aiPolicy: 'DENY',
  };
}
