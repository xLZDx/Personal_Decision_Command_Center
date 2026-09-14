import { describe, expect, it } from 'vitest';

import {
  assertBackupIntegrity,
  shouldRetainRecord,
  validateBackupManifest,
  validateOperationalSnapshot,
} from '../src/index.js';

describe('G8 operations and backup primitives', () => {
  it('validates an operator-readable snapshot and retention boundary', () => {
    expect(
      validateOperationalSnapshot({
        capturedAt: '2026-09-14T10:00:00.000Z',
        telegramListener: 'UP',
        gmailCollector: 'DEGRADED',
        acceptedEvents: 2,
        unprocessedEvents: 1,
        recoveredLeases: 0,
        restrictedProvenanceTouches: 0,
        queueBudgetRemaining: 2000,
      }),
    ).toMatchObject({ telegramListener: 'UP' });
    expect(shouldRetainRecord('2026-09-13T10:00:00.000Z', '2026-09-14T10:00:00.000Z', 2)).toBe(
      true,
    );
    expect(shouldRetainRecord('2026-09-10T10:00:00.000Z', '2026-09-14T10:00:00.000Z', 2)).toBe(
      false,
    );
  });

  it('requires encrypted, checksummed backup metadata', () => {
    const manifest = validateBackupManifest({
      version: 1,
      backupId: '00000000-0000-4000-8000-000000000081',
      createdAt: '2026-09-14T10:00:00.000Z',
      encrypted: true,
      entries: [{ path: 'd1/export.sqlite', sha256: 'a'.repeat(64), bytes: 10 }],
    });
    expect(() =>
      assertBackupIntegrity(manifest, [{ path: 'd1/export.sqlite', sha256: 'b'.repeat(64) }]),
    ).toThrow();
    expect(() =>
      assertBackupIntegrity(manifest, [{ path: 'd1/export.sqlite', sha256: 'a'.repeat(64) }]),
    ).not.toThrow();
  });
});
