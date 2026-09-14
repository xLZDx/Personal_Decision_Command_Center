import { describe, expect, it } from 'vitest';

import {
  createOpaquePushPayload,
  decodeOpaquePushPayload,
  requiresResumeSync,
} from '../src/index.js';

describe('G7 opaque push boundary', () => {
  it('contains only opaque identifiers and round-trips', () => {
    const payload = createOpaquePushPayload('00000000-0000-4000-8000-000000000071');
    expect(payload).not.toContain('body');
    expect(decodeOpaquePushPayload(payload)).toEqual({
      type: 'STATE_CHANGED',
      notification_id: '00000000-0000-4000-8000-000000000071',
      schema_version: 1,
    });
  });

  it('rejects tampering and requires sync on a cursor gap', () => {
    const payload = createOpaquePushPayload('00000000-0000-4000-8000-000000000072');
    expect(() => decodeOpaquePushPayload(`${payload}x`)).toThrow();
    expect(requiresResumeSync(null, 'cursor-8')).toBe(true);
    expect(requiresResumeSync('cursor-7', 'cursor-8')).toBe(true);
    expect(requiresResumeSync('cursor-8', 'cursor-8')).toBe(false);
  });
});
