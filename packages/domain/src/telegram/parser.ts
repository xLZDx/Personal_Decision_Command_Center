import type { StringProvenanceValue } from '@pdos/contracts';

export type TelegramSignalKind =
  | 'APPROVAL_REQUEST'
  | 'DEADLINE_EXPLICIT'
  | 'BLOCKER_EXPLICIT'
  | 'WAITING_FOR_USER'
  | 'DELIVERABLE_MENTION'
  | 'BUSINESS_IDENTIFIER';

export interface TelegramDeterministicSignal {
  kind: TelegramSignalKind;
  value: StringProvenanceValue;
}

export interface TelegramParserInput {
  eventId: string;
  text: string;
  now: string;
}

export const MAX_TELEGRAM_INPUT_CHARS = 4_000;
export const MAX_TELEGRAM_SIGNALS = 16;

const RULES: readonly [TelegramSignalKind, RegExp][] = [
  ['APPROVAL_REQUEST', /\b(?:please\s+)?approve\b/i],
  ['BLOCKER_EXPLICIT', /\b(?:blocked|blocker|blocking)\b/i],
  ['WAITING_FOR_USER', /\b(?:waiting\s+for\s+(?:your|the\s+user)|need(?:s)?\s+your\s+input)\b/i],
  ['DELIVERABLE_MENTION', /\b(?:deliverable|shipped|released|attached)\b/i],
  ['DEADLINE_EXPLICIT', /\b(?:by|due)\s+\d{4}-\d{2}-\d{2}\b/i],
];

/**
 * Small, explainable Telegram parser. It intentionally uses only fixed phrase families and
 * identifier/date regexes; no model, embeddings, or cross-channel context can enter this function.
 */
export function parseTelegramDeterministically(
  input: TelegramParserInput,
): TelegramDeterministicSignal[] {
  if (Array.from(input.text).length > MAX_TELEGRAM_INPUT_CHARS) {
    throw new Error(`Telegram input exceeds ${MAX_TELEGRAM_INPUT_CHARS} characters`);
  }
  const signals: TelegramDeterministicSignal[] = [];
  for (const [kind, rule] of RULES) {
    const match = input.text.match(rule);
    if (!match) continue;
    if (signals.length >= MAX_TELEGRAM_SIGNALS) break;
    signals.push({
      kind,
      value: {
        value: match[0],
        provenance: [input.eventId],
        derivation_method: 'RULE',
        ai_policy: 'DENY',
        sensitivity: 'telegram-derived',
        created_at: input.now,
        derivation_version: 1,
      },
    });
  }
  for (const match of input.text.matchAll(/\b[A-Z]{2,}[A-Z0-9]*(?:[-_]\d+)+\b/g)) {
    if (signals.length >= MAX_TELEGRAM_SIGNALS) break;
    signals.push({
      kind: 'BUSINESS_IDENTIFIER',
      value: {
        value: match[0],
        provenance: [input.eventId],
        derivation_method: 'RULE',
        ai_policy: 'DENY',
        sensitivity: 'telegram-derived',
        created_at: input.now,
        derivation_version: 1,
      },
    });
  }
  return signals;
}
