import { describe, expect, it } from 'vitest';
import {
  PUSH_SCHEMA_VERSION,
  PushPayloadSchema,
  QueuePayloadSchema,
  SCHEMA_VERSION,
} from '../src/index.js';

const validQueuePayload = {
  event_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  operation: 'PROCESS_EVENT',
  schema_version: SCHEMA_VERSION,
};

const validPushPayload = {
  type: 'STATE_CHANGED',
  notification_id: 'n-123',
  schema_version: PUSH_SCHEMA_VERSION,
};

describe('QueuePayload (INV-09/INV-12)', () => {
  it('accepts a pointer-only payload', () => {
    expect(QueuePayloadSchema.safeParse(validQueuePayload).success).toBe(true);
  });

  it.each(['body', 'title', 'snippet', 'subject', 'sender'])(
    'rejects a queue payload carrying source content in a %s field',
    (field) => {
      expect(
        QueuePayloadSchema.safeParse({ ...validQueuePayload, [field]: 'leaked' }).success,
      ).toBe(false);
    },
  );

  it('rejects an inlined event object, however convenient it would be', () => {
    // The temptation this guards against is real: inlining the event saves a D1 read in the
    // consumer. It also makes the queue a second source of truth for state (INV-09) and puts
    // source-derived text on the wire (INV-12).
    expect(
      QueuePayloadSchema.safeParse({ ...validQueuePayload, event: { source: 'gmail' } }).success,
    ).toBe(false);
  });
});

describe('PushPayload opacity (INV-11, ADR-008)', () => {
  it('accepts the opaque payload shape', () => {
    expect(PushPayloadSchema.safeParse(validPushPayload).success).toBe(true);
  });

  // TDD 32 enumerates exactly what may never appear in push transport. Each gets its own case so
  // a failure names the specific leak rather than "push schema broke".
  it.each([
    ['sender name', 'sender', 'Alex Petrov'],
    ['message excerpt', 'excerpt', 'Need GO on Gate 4.2'],
    ['topic title', 'title', 'ERP / Gate 4.2'],
    ['decision question', 'question', 'Approve rollout?'],
    ['source-derived deadline', 'due_at', '2026-09-11T17:00:00.000Z'],
    ['project label', 'project', 'ERP'],
    ['body', 'body', 'anything at all'],
  ])('rejects a push payload carrying a %s', (_label, field, value) => {
    expect(PushPayloadSchema.safeParse({ ...validPushPayload, [field]: value }).success).toBe(
      false,
    );
  });

  it('rejects a mismatched push schema_version', () => {
    expect(PushPayloadSchema.safeParse({ ...validPushPayload, schema_version: 2 }).success).toBe(
      false,
    );
  });
});
