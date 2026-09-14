import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTestD1 } from '@pdos/testkit';
import { persistDecision } from '../src/index.js';

describe('G6 durable decision store', () => {
  it('persists a decision and append-only audit idempotently', async () => {
    const schema = readFileSync(
      new URL('../../../infra/migrations/0012_g6_state_and_telegram_replay.sql', import.meta.url),
      'utf8',
    ) + readFileSync(new URL('../../../infra/migrations/0013_g5_core_entities.sql', import.meta.url), 'utf8') +
      readFileSync(new URL('../../../infra/migrations/0015_g6_integrity_triggers.sql', import.meta.url), 'utf8');
    const db = createTestD1(schema);
    await db.prepare("INSERT INTO projects VALUES ('p', 'one', 'One', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z')").run();
    await db.prepare("INSERT INTO topics VALUES ('t1', 'p', NULL, 'ONE::1', 'ACTIVE', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z')").run();
    const input = {
      decisionId: 'd1',
      topicId: 't1',
      state: 'OPEN' as const,
      owner: 'p1',
      recommendation: null,
      priority: 'P2' as const,
      evidenceIds: ['e1'],
      aiPolicy: 'DENY' as const,
      now: '2026-09-14T10:00:00.000Z',
      auditId: 'da1',
      actor: 'op1',
    };
    expect(await persistDecision(db, input)).toBe(true);
    expect(await persistDecision(db, input)).toBe(true);
    expect(
      (await db.prepare('SELECT count(*) AS n FROM decision_state_audit').first<{ n: number }>())
        ?.n,
    ).toBe(1);
    await expect(persistDecision(db, { ...input, state: 'RESOLVED', auditId: 'da2' })).rejects.toThrow(/invalid decision transition/);
    await expect(persistDecision(db, { ...input, evidenceIds: ['tampered'] })).rejects.toThrow(/audit id/);
  });
});
