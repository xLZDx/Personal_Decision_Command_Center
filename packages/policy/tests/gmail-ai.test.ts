/* global TextEncoder */
import { describe, expect, it } from 'vitest';

import {
  AIContextPolicyError,
  GmailAIContextBuilder,
  GmailEvidenceBundleSchema,
  GmailSourceEnrichmentSchema,
  NoAIProvider,
  WORKERS_AI_MAX_REQUEST_UTF8_BYTES,
  WORKERS_AI_MODEL_ID,
} from '../src/index.js';
import type { GmailEvidenceBundle } from '../src/index.js';

function bundle(overrides: Partial<GmailEvidenceBundle> = {}): GmailEvidenceBundle {
  return {
    eventId: 'event-1',
    source: 'gmail',
    sourcePolicyId: 'gmail-policy-1',
    sourcePolicy: {
      source_policy_id: 'gmail-policy-1',
      source: 'gmail',
      ai_policy: 'ALLOW',
      version: 1,
    },
    provenanceRootId: 'derived-1',
    provenanceNodes: [
      {
        kind: 'SOURCE_EVENT',
        id: 'event-1',
        source: 'gmail',
        ai_policy: 'ALLOW',
        provenance: [],
      },
      {
        kind: 'DERIVED',
        id: 'derived-1',
        ai_policy: 'ALLOW',
        provenance: ['event-1'],
      },
    ],
    message: {
      messageId: 'message-1',
      threadId: 'thread-1',
      subject: 'Please review project ALPHA-SECRET',
      from: 'sender@example.test',
      to: ['owner@example.test'],
      sentAt: '2026-09-14T08:00:00.000Z',
      plainText:
        'Please approve the launch by 2026-09-15. ALPHA-SECRET\n\n' +
        'On Sun, 13 Sep 2026, Someone wrote:\n> old confidential context',
    },
    ...overrides,
  };
}

describe('GmailAIContextBuilder', () => {
  it('builds the only approved Gmail-local request, strips history, and redacts configured secrets', () => {
    const request = new GmailAIContextBuilder({ secrets: ['ALPHA-SECRET'] }).build(bundle());

    expect(request.model).toBe(WORKERS_AI_MODEL_ID);
    expect(request.max_tokens).toBe(256);
    expect(request.temperature).toBe(0);
    expect(request.response_format.type).toBe('json_schema');
    expect(request.messages[1].content).toContain('[REDACTED]');
    expect(request.messages[1].content).not.toContain('ALPHA-SECRET');
    expect(request.messages[1].content).not.toContain('old confidential context');
    expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBeLessThanOrEqual(
      WORKERS_AI_MAX_REQUEST_UTF8_BYTES,
    );
  });

  it('removes quoted lines and a deterministic signature block', () => {
    const input = bundle({
      message: {
        ...bundle().message,
        plainText: 'current\n> quoted\nkeep\n--\nsignature secret',
      },
    });
    const content = new GmailAIContextBuilder().build(input).messages[1].content;
    expect(content).toContain('current\\nkeep');
    expect(content).not.toContain('quoted');
    expect(content).not.toContain('signature secret');
  });

  it('bounds even highly escapable input by serialized request bytes', () => {
    const input = bundle({
      message: { ...bundle().message, plainText: String.fromCharCode(92, 34).repeat(40_000) },
    });
    const request = new GmailAIContextBuilder().build(input);
    expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBeLessThanOrEqual(
      WORKERS_AI_MAX_REQUEST_UTF8_BYTES,
    );
  });

  it('fails closed when the source policy is DENY', () => {
    const input = bundle({
      sourcePolicy: { ...bundle().sourcePolicy, ai_policy: 'DENY' },
    });
    expect(() => new GmailAIContextBuilder().build(input)).toThrow(AIContextPolicyError);
  });

  it('fails closed when the source-policy id is mismatched', () => {
    const input = bundle({ sourcePolicyId: 'different-policy' });
    expect(() => new GmailAIContextBuilder().build(input)).toThrow(/source policy/);
  });

  it('fails closed on Telegram ancestry even when every node says ALLOW', () => {
    const input = bundle({
      provenanceNodes: [
        {
          kind: 'SOURCE_EVENT',
          id: 'telegram-event',
          source: 'telegram',
          ai_policy: 'ALLOW',
          provenance: [],
        },
        {
          kind: 'DERIVED',
          id: 'derived-1',
          ai_policy: 'ALLOW',
          provenance: ['telegram-event'],
        },
      ],
    });
    expect(() => new GmailAIContextBuilder().build(input)).toThrow(/non-Gmail/i);
  });

  it('fails closed on mixed Gmail and Telegram ancestry', () => {
    const input = bundle({
      provenanceNodes: [
        ...bundle().provenanceNodes,
        {
          kind: 'SOURCE_EVENT',
          id: 'telegram-event',
          source: 'telegram',
          ai_policy: 'ALLOW',
          provenance: [],
        },
        {
          kind: 'DERIVED',
          id: 'mixed',
          ai_policy: 'ALLOW',
          provenance: ['derived-1', 'telegram-event'],
        },
      ],
      provenanceRootId: 'mixed',
    });
    expect(() => new GmailAIContextBuilder().build(input)).toThrow(/non-Gmail/i);
  });

  it('rejects even a disconnected Telegram node from a GmailEvidenceBundle', () => {
    const input = bundle({
      provenanceNodes: [
        ...bundle().provenanceNodes,
        {
          kind: 'SOURCE_EVENT',
          id: 'disconnected-telegram-event',
          source: 'telegram',
          ai_policy: 'ALLOW',
          provenance: [],
        },
      ],
    });
    expect(() => new GmailAIContextBuilder().build(input)).toThrow(/must not contain non-Gmail/);
  });

  it('fails closed on unresolved ancestry and duplicate node ids', () => {
    const unresolved = bundle({
      provenanceNodes: [
        {
          kind: 'DERIVED',
          id: 'derived-1',
          ai_policy: 'ALLOW',
          provenance: ['missing'],
        },
      ],
    });
    expect(() => new GmailAIContextBuilder().build(unresolved)).toThrow();

    const duplicate = bundle({
      provenanceNodes: [...bundle().provenanceNodes, bundle().provenanceNodes[0]!],
    });
    expect(() => new GmailAIContextBuilder().build(duplicate)).toThrow(/Duplicate/);
  });

  it('rejects an empty redaction secret instead of replacing every string boundary', () => {
    expect(() => new GmailAIContextBuilder({ secrets: [''] })).toThrow(AIContextPolicyError);
  });

  it('rejects Topic-shaped objects at compile time and at the runtime boundary', () => {
    const builder = new GmailAIContextBuilder();
    const buildFromTopic = () => {
      // @ts-expect-error TDD §24: there is deliberately no Topic overload.
      return builder.build({ kind: 'Topic', id: 'topic-1' });
    };
    expect(buildFromTopic).toThrow();
  });

  it('uses a strict bundle schema so smuggled cross-channel fields are rejected', () => {
    const input = { ...bundle(), telegramContext: 'must never enter AI' };
    expect(() => GmailEvidenceBundleSchema.parse(input)).toThrow();
  });
});

describe('GmailSourceEnrichmentSchema', () => {
  it('accepts a bounded structured extraction', () => {
    expect(
      GmailSourceEnrichmentSchema.parse({
        summary: 'Approval requested by tomorrow.',
        signals: [
          {
            kind: 'ACTION_REQUEST',
            text: 'Approve the launch',
            dueAt: '2026-09-15T00:00:00.000Z',
          },
        ],
      }),
    ).toBeTruthy();
  });

  it('rejects malformed, oversized, and extra output instead of trusting JSON Mode', () => {
    expect(() =>
      GmailSourceEnrichmentSchema.parse({ summary: '', signals: [], extra: 'untrusted' }),
    ).toThrow();
    expect(() =>
      GmailSourceEnrichmentSchema.parse({
        summary: 'x',
        signals: [{ kind: 'ACTION_REQUEST', text: 'x', dueAt: 'tomorrow' }],
      }),
    ).toThrow();
    expect(() =>
      GmailSourceEnrichmentSchema.parse({
        summary: 'x',
        signals: Array.from({ length: 21 }, () => ({
          kind: 'FYI',
          text: 'x',
          dueAt: null,
        })),
      }),
    ).toThrow();
  });
});

describe('NoAIProvider', () => {
  it('degrades explicitly without making an inference', async () => {
    const request = new GmailAIContextBuilder().build(bundle());
    await expect(new NoAIProvider().run(request)).resolves.toEqual({ status: 'DISABLED' });
  });
});
