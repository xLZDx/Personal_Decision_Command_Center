import { describe, expect, it } from 'vitest';

import { classifyTelegramIntent } from '../../src/index.js';

describe('classifyTelegramIntent', () => {
  it('uses deterministic priority and Telegram-deny provenance', () => {
    const result = classifyTelegramIntent({
      eventId: 'tg-1',
      text: 'Blocked: please approve by 2026-09-20',
      now: '2026-09-14T00:00:00.000Z',
    });
    expect(result.intent).toBe('BLOCKER');
    expect(result.evidence[0]?.ai_policy).toBe('DENY');
    expect(result.evidence[0]?.provenance).toEqual(['tg-1']);
  });

  it('returns FYI with no fabricated evidence when no rule matches', () => {
    expect(
      classifyTelegramIntent({
        eventId: 'tg-2',
        text: 'Hello there',
        now: '2026-09-14T00:00:00.000Z',
      }),
    ).toEqual({ intent: 'FYI', evidence: [] });
  });
});
