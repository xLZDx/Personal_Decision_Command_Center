import { describe, expect, it } from 'vitest';
import {
  MAX_ROUTING_HINT_VALUE_LENGTH,
  MAX_ROUTING_HINTS,
  NormalizedEventSchema,
  ProvenanceValueSchema,
  SCHEMA_VERSION,
  SourceVersionSchema,
  idempotencyKey,
  provenanceValueSchema,
  type NormalizedEvent,
} from '../src/index.js';
import { z } from 'zod';

const PROVENANCE_EXTRAS = {
  sensitivity: 'general',
  created_at: '2026-09-10T12:00:00.000Z',
  derivation_version: 1,
};

function gmailEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    source: 'gmail',
    source_account_id: 'acct-gmail-1',
    source_event_id: 'msg-abc123',
    source_thread_id: 'thread-xyz',
    event_type: 'MESSAGE_CREATED',
    direction: 'INBOUND',
    occurred_at: '2026-09-10T12:00:00.000Z',
    received_at: '2026-09-10T12:00:01.000Z',
    content_locator: { kind: 'SOURCE_REF', ref: 'gmail:msg-abc123' },
    routing_hints: [],
    source_policy_id: 'policy-gmail-v1',
    trace_id: 'trace-1',
    schema_version: SCHEMA_VERSION,
    source_version: null,
    ...overrides,
  };
}

function telegramEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return gmailEvent({
    source: 'telegram',
    source_account_id: 'acct-tg-1',
    source_event_id: '4242',
    content_locator: { kind: 'SOURCE_REF', ref: 'telegram:chat/1/msg/4242' },
    source_policy_id: 'policy-telegram-v1',
    ...overrides,
  });
}

const allowHint = {
  value: 'ERP::Gate-4.2',
  provenance: ['msg-abc123'],
  derivation_method: 'RULE',
  ai_policy: 'ALLOW',
  ...PROVENANCE_EXTRAS,
};

const denyHint = { ...allowHint, provenance: ['4242'], ai_policy: 'DENY' };

describe('NormalizedEvent envelope', () => {
  it('accepts a well-formed Gmail event', () => {
    expect(NormalizedEventSchema.safeParse(gmailEvent()).success).toBe(true);
  });

  it('accepts a well-formed Telegram event', () => {
    expect(NormalizedEventSchema.safeParse(telegramEvent()).success).toBe(true);
  });

  // INV-12/INV-14: raw bodies are not part of the central contract. If this test ever has to be
  // relaxed, that is an architecture change requiring an ADR -- not a schema tweak.
  it.each(['body', 'text', 'snippet', 'subject', 'html'])(
    'rejects an event carrying raw content in a %s field',
    (field) => {
      const result = NormalizedEventSchema.safeParse(gmailEvent({ [field]: 'secret content' }));
      expect(result.success).toBe(false);
    },
  );

  it('rejects an unknown field even when it looks harmless', () => {
    // Strictness is the point: "harmless" is a judgement the schema is not in a position to make.
    expect(NormalizedEventSchema.safeParse(gmailEvent({ priority_hint: 3 })).success).toBe(false);
  });

  it('rejects a mismatched schema_version', () => {
    expect(NormalizedEventSchema.safeParse(gmailEvent({ schema_version: 2 })).success).toBe(false);
  });

  it('rejects a non-UUID event_id', () => {
    expect(NormalizedEventSchema.safeParse(gmailEvent({ event_id: 'not-a-uuid' })).success).toBe(
      false,
    );
  });

  it('rejects a timestamp without an offset', () => {
    expect(
      NormalizedEventSchema.safeParse(gmailEvent({ occurred_at: '2026-09-10 12:00:00' })).success,
    ).toBe(false);
  });

  it('rejects a missing source_version key (nullable, not optional)', () => {
    const event = gmailEvent();
    delete (event as Record<string, unknown>).source_version;
    expect(NormalizedEventSchema.safeParse(event).success).toBe(false);
  });

  describe('routing_hints cap (MAX_ROUTING_HINTS)', () => {
    it(`accepts exactly ${MAX_ROUTING_HINTS} routing hints`, () => {
      const hints = Array.from({ length: MAX_ROUTING_HINTS }, () => denyHint);
      expect(NormalizedEventSchema.safeParse(gmailEvent({ routing_hints: hints })).success).toBe(
        true,
      );
    });

    it(`rejects ${MAX_ROUTING_HINTS + 1} routing hints`, () => {
      const hints = Array.from({ length: MAX_ROUTING_HINTS + 1 }, () => denyHint);
      expect(NormalizedEventSchema.safeParse(gmailEvent({ routing_hints: hints })).success).toBe(
        false,
      );
    });
  });

  describe('routing_hints value length bound (security fix, G2 review MAJOR)', () => {
    it(`accepts a value of exactly ${MAX_ROUTING_HINT_VALUE_LENGTH} characters`, () => {
      const hint = { ...denyHint, value: 'a'.repeat(MAX_ROUTING_HINT_VALUE_LENGTH) };
      expect(NormalizedEventSchema.safeParse(gmailEvent({ routing_hints: [hint] })).success).toBe(
        true,
      );
    });

    it(`rejects a value of ${MAX_ROUTING_HINT_VALUE_LENGTH + 1} characters -- a routing hint is metadata, not a place to smuggle raw content (INV-12/INV-14)`, () => {
      const hint = { ...denyHint, value: 'a'.repeat(MAX_ROUTING_HINT_VALUE_LENGTH + 1) };
      expect(NormalizedEventSchema.safeParse(gmailEvent({ routing_hints: [hint] })).success).toBe(
        false,
      );
    });
  });

  describe('source_version, mandatory for MESSAGE_UPDATED (M4)', () => {
    it('rejects MESSAGE_UPDATED with a null source_version', () => {
      const result = NormalizedEventSchema.safeParse(
        gmailEvent({ event_type: 'MESSAGE_UPDATED', source_version: null }),
      );
      expect(result.success).toBe(false);
      const paths = result.success ? [] : result.error.issues.map((issue) => issue.path);
      expect(paths).toContainEqual(['source_version']);
    });

    it('accepts MESSAGE_UPDATED with a non-empty source_version', () => {
      expect(
        NormalizedEventSchema.safeParse(
          gmailEvent({ event_type: 'MESSAGE_UPDATED', source_version: 'rev-2' }),
        ).success,
      ).toBe(true);
    });

    it('accepts MESSAGE_CREATED with a null source_version (not required outside MESSAGE_UPDATED)', () => {
      expect(
        NormalizedEventSchema.safeParse(
          gmailEvent({ event_type: 'MESSAGE_CREATED', source_version: null }),
        ).success,
      ).toBe(true);
    });
  });
});

describe('SourceVersionSchema: non-mutating whitespace rejection (Round 4 MAJOR correction)', () => {
  it('rejects an empty string', () => {
    expect(SourceVersionSchema.safeParse('').success).toBe(false);
  });

  it('rejects a whitespace-only string', () => {
    expect(SourceVersionSchema.safeParse(' ').success).toBe(false);
    expect(SourceVersionSchema.safeParse('\t').success).toBe(false);
  });

  it('accepts null', () => {
    expect(SourceVersionSchema.safeParse(null).success).toBe(true);
  });

  it('parses a padded-but-real value UNCHANGED -- proving no .trim() transform mutated it', () => {
    const result = SourceVersionSchema.safeParse(' rev-1 ');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(' rev-1 ');
    }
  });
});

describe('Telegram AI-policy boundary guard (INV-03/INV-04)', () => {
  it('rejects a Telegram event whose routing hint claims ai_policy ALLOW', () => {
    const result = NormalizedEventSchema.safeParse(
      telegramEvent({ routing_hints: [{ ...allowHint, provenance: ['4242'] }] }),
    );
    expect(result.success).toBe(false);
    // Assert the issue points at the offending hint, not merely that something failed -- a
    // schema that rejected every Telegram event outright would also make `success` false.
    const paths = result.success ? [] : result.error.issues.map((issue) => issue.path);
    expect(paths).toContainEqual(['routing_hints', 0, 'ai_policy']);
  });

  it('rejects the ALLOW hint even when a valid DENY hint precedes it', () => {
    // Guards that only inspect the first element are a classic partial fix; this fixture fails
    // if the check ever degrades to `routing_hints[0]`.
    const result = NormalizedEventSchema.safeParse(
      telegramEvent({ routing_hints: [denyHint, { ...allowHint, provenance: ['4242'] }] }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts a Telegram event whose routing hints are all DENY', () => {
    expect(
      NormalizedEventSchema.safeParse(telegramEvent({ routing_hints: [denyHint] })).success,
    ).toBe(true);
  });

  // Control: proves the guard is source-specific rather than a blanket rejection of ALLOW that
  // would make the tests above pass for the wrong reason.
  it('accepts a Gmail event whose routing hint is ai_policy ALLOW', () => {
    expect(
      NormalizedEventSchema.safeParse(gmailEvent({ routing_hints: [allowHint] })).success,
    ).toBe(true);
  });
});

describe('ProvenanceValue', () => {
  it('rejects a value with no recorded ancestry', () => {
    // Empty ancestry must not read as "no restricted ancestors" -- that is the fail-open the
    // composition rule forbids (TDD 7.2).
    expect(ProvenanceValueSchema.safeParse({ ...allowHint, provenance: [] }).success).toBe(false);
  });

  it('rejects an unknown ai_policy such as UNKNOWN', () => {
    expect(ProvenanceValueSchema.safeParse({ ...allowHint, ai_policy: 'UNKNOWN' }).success).toBe(
      false,
    );
  });

  it('rejects a missing sensitivity (M5: required, non-optional)', () => {
    const { sensitivity: _sensitivity, ...withoutSensitivity } = allowHint;
    expect(ProvenanceValueSchema.safeParse(withoutSensitivity).success).toBe(false);
  });

  it('rejects an empty sensitivity string', () => {
    expect(ProvenanceValueSchema.safeParse({ ...allowHint, sensitivity: '' }).success).toBe(false);
  });

  it('rejects a missing created_at or derivation_version', () => {
    const { created_at: _createdAt, ...withoutCreatedAt } = allowHint;
    expect(ProvenanceValueSchema.safeParse(withoutCreatedAt).success).toBe(false);
    const { derivation_version: _dv, ...withoutDerivationVersion } = allowHint;
    expect(ProvenanceValueSchema.safeParse(withoutDerivationVersion).success).toBe(false);
  });

  describe('provenanceValueSchema<T> factory: STATIC_CONFIG zero-ancestor exception (M5)', () => {
    const numberSchema = provenanceValueSchema(z.number());

    it('rejects zero-ancestor provenance for a non-STATIC_CONFIG derivation method', () => {
      expect(
        numberSchema.safeParse({
          value: 42,
          provenance: [],
          derivation_method: 'RULE',
          ai_policy: 'DENY',
          ...PROVENANCE_EXTRAS,
        }).success,
      ).toBe(false);
    });

    it('accepts zero-ancestor provenance for STATIC_CONFIG specifically', () => {
      expect(
        numberSchema.safeParse({
          value: 42,
          provenance: [],
          derivation_method: 'STATIC_CONFIG',
          ai_policy: 'ALLOW',
          ...PROVENANCE_EXTRAS,
        }).success,
      ).toBe(true);
    });
  });
});

describe('idempotencyKey (INV-08, M4)', () => {
  const base = {
    source_account_id: 'acct-1',
    source_event_id: 'evt-1',
    event_type: 'MESSAGE_CREATED',
    source_version: null,
  } as Pick<
    NormalizedEvent,
    'source_account_id' | 'source_event_id' | 'event_type' | 'source_version'
  >;

  it('is stable across retries that differ only in transport bookkeeping', () => {
    expect(idempotencyKey(base)).toBe(idempotencyKey({ ...base }));
  });

  it('distinguishes field-boundary-shifted inputs that a delimiter join would collide', () => {
    // ("a b", "c") vs ("a", "b c"): identical under a space join, distinct events in reality.
    // A collision here silently drops one of the two as a duplicate.
    const left = idempotencyKey({ ...base, source_account_id: 'a b', source_event_id: 'c' });
    const right = idempotencyKey({ ...base, source_account_id: 'a', source_event_id: 'b c' });
    expect(left).not.toBe(right);
  });

  it('distinguishes inputs shifted across a colon, which the length prefix itself uses', () => {
    const left = idempotencyKey({ ...base, source_account_id: '1:x', source_event_id: 'y' });
    const right = idempotencyKey({ ...base, source_account_id: '1', source_event_id: 'x:y' });
    expect(left).not.toBe(right);
  });

  it('distinguishes different event types on the same source event', () => {
    expect(idempotencyKey({ ...base, event_type: 'MESSAGE_CREATED' })).not.toBe(
      idempotencyKey({ ...base, event_type: 'MESSAGE_UPDATED' }),
    );
  });

  it('distinguishes different source_version revisions on the same source event (M4)', () => {
    const rev1 = idempotencyKey({
      ...base,
      event_type: 'MESSAGE_UPDATED',
      source_version: 'rev-1',
    });
    const rev2 = idempotencyKey({
      ...base,
      event_type: 'MESSAGE_UPDATED',
      source_version: 'rev-2',
    });
    expect(rev1).not.toBe(rev2);
  });

  it('is stable for the identical source_version across retries', () => {
    const a = idempotencyKey({ ...base, event_type: 'MESSAGE_UPDATED', source_version: 'rev-1' });
    const b = idempotencyKey({ ...base, event_type: 'MESSAGE_UPDATED', source_version: 'rev-1' });
    expect(a).toBe(b);
  });

  it('treats a null source_version distinctly from any real revision string', () => {
    const withNull = idempotencyKey({ ...base, source_version: null });
    const withEmptyLookingRevision = idempotencyKey({ ...base, source_version: '0:' });
    // Both length-prefix to different strings ("0:" is itself length-prefixed as "2:0:"), so this
    // guards against an accidental collision between "no revision" and a revision that happens to
    // look like the null placeholder.
    expect(withNull).not.toBe(withEmptyLookingRevision);
  });
});
