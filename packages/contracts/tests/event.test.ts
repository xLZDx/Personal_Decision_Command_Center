import { describe, expect, it } from 'vitest';
import {
  NormalizedEventSchema,
  ProvenanceValueSchema,
  SCHEMA_VERSION,
  idempotencyKey,
  type NormalizedEvent,
} from '../src/index.js';

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
});

describe('idempotencyKey (INV-08)', () => {
  const base = {
    source_account_id: 'acct-1',
    source_event_id: 'evt-1',
    event_type: 'MESSAGE_CREATED',
  } as Pick<NormalizedEvent, 'source_account_id' | 'source_event_id' | 'event_type'>;

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
});
