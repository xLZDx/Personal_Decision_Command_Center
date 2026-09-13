import { describe, expect, it } from 'vitest';

import { SourcePolicyRecordSchema } from '../src/source-policy.js';

describe('SourcePolicyRecordSchema', () => {
  it('accepts a well-formed row', () => {
    const result = SourcePolicyRecordSchema.safeParse({
      source_policy_id: 'p-gmail',
      source: 'gmail',
      ai_policy: 'ALLOW',
      version: 1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a source outside SOURCES', () => {
    const result = SourcePolicyRecordSchema.safeParse({
      source_policy_id: 'p-x',
      source: 'slack',
      ai_policy: 'ALLOW',
      version: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an ai_policy outside AI_POLICIES', () => {
    const result = SourcePolicyRecordSchema.safeParse({
      source_policy_id: 'p-x',
      source: 'gmail',
      ai_policy: 'MAYBE',
      version: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive version', () => {
    const result = SourcePolicyRecordSchema.safeParse({
      source_policy_id: 'p-x',
      source: 'gmail',
      ai_policy: 'ALLOW',
      version: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown extra fields (.strict())', () => {
    const result = SourcePolicyRecordSchema.safeParse({
      source_policy_id: 'p-x',
      source: 'gmail',
      ai_policy: 'ALLOW',
      version: 1,
      extra: 'nope',
    });
    expect(result.success).toBe(false);
  });
});
