import { describe, expect, it } from 'vitest';

import { MAX_TELEGRAM_INPUT_CHARS, parseTelegramDeterministically } from '../../src/index.js';

describe('parseTelegramDeterministically', () => {
  it('extracts fixed rules and identifiers with DENY Telegram provenance', () => {
    const result = parseTelegramDeterministically({
      eventId: 'telegram-event-1',
      text: 'Please approve ALPHA-42 by 2026-09-20; currently blocked.',
      now: '2026-09-14T00:00:00.000Z',
    });
    expect(result.map((signal) => signal.kind)).toEqual([
      'APPROVAL_REQUEST',
      'BLOCKER_EXPLICIT',
      'DEADLINE_EXPLICIT',
      'BUSINESS_IDENTIFIER',
    ]);
    expect(result.every((signal) => signal.value.ai_policy === 'DENY')).toBe(true);
    expect(result.every((signal) => signal.value.provenance[0] === 'telegram-event-1')).toBe(true);
  });

  it('extracts namespaced project identifiers used by the resolver', () => {
    expect(
      parseTelegramDeterministically({
        eventId: 'telegram-event-4',
        text: 'ERP::Gate-4.2 is ready',
        now: '2026-09-14T00:00:00.000Z',
      }).find((signal) => signal.kind === 'BUSINESS_IDENTIFIER')?.value.value,
    ).toBe('ERP::Gate-4.2');
  });

  it('does not infer semantics from arbitrary prose', () => {
    expect(
      parseTelegramDeterministically({
        eventId: 'telegram-event-2',
        text: 'A calm status update with no configured phrases.',
        now: '2026-09-14T00:00:00.000Z',
      }),
    ).toEqual([]);
  });

  it('bounds source-local parser input before regex work', () => {
    expect(() =>
      parseTelegramDeterministically({
        eventId: 'telegram-event-3',
        text: 'x'.repeat(MAX_TELEGRAM_INPUT_CHARS + 1),
        now: '2026-09-14T00:00:00.000Z',
      }),
    ).toThrow(/exceeds/);
  });
});
