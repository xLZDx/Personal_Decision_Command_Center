import { describe, expect, it } from 'vitest';

import { buildTelegramDeterministicEnrichment } from '../../src/index.js';

describe('buildTelegramDeterministicEnrichment', () => {
  it('composes deterministic intent/signals with deny provenance and no body output', () => {
    const result = buildTelegramDeterministicEnrichment({
      eventId: 'telegram-event-1',
      text: 'Blocked: please approve ERP-42 by 2026-09-20',
      now: '2026-09-14T00:00:00.000Z',
    });
    expect(result).toMatchObject({
      source: 'telegram',
      eventId: 'telegram-event-1',
      aiPolicy: 'DENY',
    });
    expect(result.intent.value).toBe('BLOCKER');
    expect(result.intent.provenance).toEqual(['telegram-event-1']);
    expect(result.signals.map((signal) => signal.kind)).toEqual([
      'APPROVAL_REQUEST',
      'BLOCKER_EXPLICIT',
      'DEADLINE_EXPLICIT',
      'BUSINESS_IDENTIFIER',
    ]);
    expect(JSON.stringify(result)).not.toContain('Blocked: please approve');
  });

  it('returns an explicit FYI with empty evidence for unmatched prose', () => {
    expect(
      buildTelegramDeterministicEnrichment({
        eventId: 'telegram-event-2',
        text: 'hello from the source',
        now: '2026-09-14T00:00:00.000Z',
      }),
    ).toMatchObject({ signals: [], aiPolicy: 'DENY' });
    expect(
      buildTelegramDeterministicEnrichment({
        eventId: 'telegram-event-2',
        text: 'hello from the source',
        now: '2026-09-14T00:00:00.000Z',
      }).intent,
    ).toMatchObject({ value: 'FYI', provenance: ['telegram-event-2'], ai_policy: 'DENY' });
  });
});
