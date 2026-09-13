/* global TextEncoder */
import { z } from 'zod';
import { ProvenanceNodeSchema, SourcePolicyRecordSchema, assertAiSafe } from '@pdos/provenance';
import type { ProvenanceLookup, ProvenanceNode } from '@pdos/provenance';

import {
  WORKERS_AI_MAX_OUTPUT_TOKENS,
  WORKERS_AI_MAX_REQUEST_UTF8_BYTES,
  WORKERS_AI_MODEL_ID,
  assertWorkersAiRequestSize,
  estimateWorkersAiNeurons,
} from './workers-ai.js';

const MAX_HEADER_LENGTH = 1_000;
const MAX_ADDRESS_COUNT = 100;
const MAX_BODY_INPUT_LENGTH = 100_000;
const MAX_SIGNAL_COUNT = 20;

const GmailEvidenceMessageSchema = z
  .object({
    messageId: z.string().min(1).max(512),
    threadId: z.string().min(1).max(512),
    subject: z.string().max(MAX_HEADER_LENGTH),
    from: z.string().max(MAX_HEADER_LENGTH),
    to: z.array(z.string().max(MAX_HEADER_LENGTH)).max(MAX_ADDRESS_COUNT),
    sentAt: z.string().datetime({ offset: true }),
    plainText: z.string().max(MAX_BODY_INPUT_LENGTH),
  })
  .strict();

/** The only MVP1 shape accepted by GmailAIContextBuilder.build(). */
export const GmailEvidenceBundleSchema = z
  .object({
    eventId: z.string().min(1).max(512),
    source: z.literal('gmail'),
    sourcePolicyId: z.string().min(1).max(512),
    sourcePolicy: SourcePolicyRecordSchema,
    provenanceRootId: z.string().min(1).max(512),
    provenanceNodes: z.array(ProvenanceNodeSchema).min(1).max(256),
    message: GmailEvidenceMessageSchema,
  })
  .strict();

export type GmailEvidenceBundle = z.infer<typeof GmailEvidenceBundleSchema>;

const GmailSignalSchema = z
  .object({
    kind: z.enum([
      'ACTION_REQUEST',
      'DECISION',
      'DEADLINE',
      'DELIVERABLE',
      'MILESTONE_UPDATE',
      'FYI',
      'UNKNOWN',
    ]),
    text: z.string().min(1).max(1_000),
    dueAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export const GmailSourceEnrichmentSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    signals: z.array(GmailSignalSchema).max(MAX_SIGNAL_COUNT),
  })
  .strict();

export type GmailSourceEnrichment = z.infer<typeof GmailSourceEnrichmentSchema>;

const AI_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'signals'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 2_000 },
    signals: {
      type: 'array',
      maxItems: MAX_SIGNAL_COUNT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text', 'dueAt'],
        properties: {
          kind: {
            type: 'string',
            enum: [
              'ACTION_REQUEST',
              'DECISION',
              'DEADLINE',
              'DELIVERABLE',
              'MILESTONE_UPDATE',
              'FYI',
              'UNKNOWN',
            ],
          },
          text: { type: 'string', minLength: 1, maxLength: 1_000 },
          dueAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
        },
      },
    },
  },
} as const;

export const AIRequestSchema = z
  .object({
    model: z.literal(WORKERS_AI_MODEL_ID),
    messages: z.tuple([
      z.object({ role: z.literal('system'), content: z.string().min(1) }).strict(),
      z.object({ role: z.literal('user'), content: z.string().min(1) }).strict(),
    ]),
    response_format: z
      .object({
        type: z.literal('json_schema'),
        json_schema: z.unknown(),
      })
      .strict(),
    max_tokens: z.literal(WORKERS_AI_MAX_OUTPUT_TOKENS),
    temperature: z.literal(0),
  })
  .strict();

export type AIRequest = z.infer<typeof AIRequestSchema>;

export interface AIProviderUsage {
  promptTokens: number;
  completionTokens: number;
}

export type AIProviderResult =
  { status: 'COMPLETE'; output: unknown; usage?: AIProviderUsage } | { status: 'DISABLED' };

export interface AIProvider {
  run(request: AIRequest): Promise<AIProviderResult>;
}

export class NoAIProvider implements AIProvider {
  async run(_request: AIRequest): Promise<AIProviderResult> {
    return { status: 'DISABLED' };
  }
}

export class AIContextPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIContextPolicyError';
  }
}

export interface GmailAIContextBuilderOptions {
  /** Exact literal values removed from headers/body. Empty values are rejected. */
  secrets?: readonly string[];
}

function stripQuotedHistoryAndBoilerplate(value: string): string {
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (/^On .+ wrote:$/.test(line.trim())) break;
    if (line.trim() === '--') break;
    if (line.trimStart().startsWith('>')) continue;
    kept.push(line);
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function redact(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
  return result;
}

function indexProvenance(nodes: readonly ProvenanceNode[]): Map<string, ProvenanceNode> {
  const index = new Map<string, ProvenanceNode>();
  for (const node of nodes) {
    if (index.has(node.id))
      throw new AIContextPolicyError(`Duplicate provenance node "${node.id}"`);
    index.set(node.id, node);
  }
  return index;
}

function assertGmailOnlyReachable(root: ProvenanceNode, lookup: ProvenanceLookup): void {
  const pending: ProvenanceNode[] = [root];
  const seen = new Set<string>();
  let gmailRootCount = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    if (node.kind === 'SOURCE_EVENT') {
      if (node.source !== 'gmail') {
        throw new AIContextPolicyError(`Non-Gmail provenance node "${node.id}" is AI-ineligible`);
      }
      gmailRootCount += 1;
    }
    for (const ancestorId of node.provenance) {
      const ancestor = lookup(ancestorId);
      const parsed = ProvenanceNodeSchema.safeParse(ancestor);
      if (!parsed.success) {
        throw new AIContextPolicyError(`Unresolved provenance node "${ancestorId}"`);
      }
      pending.push(parsed.data);
    }
  }
  if (gmailRootCount === 0) {
    throw new AIContextPolicyError(
      'Gmail evidence must reach at least one Gmail SOURCE_EVENT root',
    );
  }
}

const SYSTEM_PROMPT =
  'Extract only facts explicitly present in the supplied Gmail evidence. Do not infer from absent ' +
  'context. Return JSON matching the supplied schema. Use UNKNOWN when no specific signal applies.';

export class GmailAIContextBuilder {
  readonly #secrets: readonly string[];

  constructor(options: GmailAIContextBuilderOptions = {}) {
    this.#secrets = [...(options.secrets ?? [])];
    if (this.#secrets.some((secret) => secret.length === 0)) {
      throw new AIContextPolicyError('Configured redaction secrets must not be empty');
    }
  }

  build(candidate: GmailEvidenceBundle): AIRequest {
    const bundle = GmailEvidenceBundleSchema.parse(candidate);
    if (
      bundle.sourcePolicy.source !== 'gmail' ||
      bundle.sourcePolicy.ai_policy !== 'ALLOW' ||
      bundle.sourcePolicy.source_policy_id !== bundle.sourcePolicyId
    ) {
      throw new AIContextPolicyError(
        'Resolved Gmail source policy must match and explicitly ALLOW AI',
      );
    }

    const provenance = indexProvenance(bundle.provenanceNodes);
    for (const node of provenance.values()) {
      if (node.kind === 'SOURCE_EVENT' && node.source !== 'gmail') {
        throw new AIContextPolicyError(
          `GmailEvidenceBundle must not contain non-Gmail source node "${node.id}"`,
        );
      }
    }
    const root = provenance.get(bundle.provenanceRootId);
    if (!root) throw new AIContextPolicyError('provenanceRootId does not resolve');
    const lookup: ProvenanceLookup = (id) => provenance.get(id);
    assertAiSafe(root, lookup, root.id);
    assertGmailOnlyReachable(root, lookup);

    const cleanedBody = redact(
      stripQuotedHistoryAndBoilerplate(bundle.message.plainText),
      this.#secrets,
    );
    const evidence = {
      eventId: bundle.eventId,
      messageId: bundle.message.messageId,
      threadId: bundle.message.threadId,
      sentAt: bundle.message.sentAt,
      from: redact(bundle.message.from, this.#secrets),
      to: bundle.message.to.map((address) => redact(address, this.#secrets)),
      subject: redact(bundle.message.subject, this.#secrets),
      body: cleanedBody,
    };

    const makeRequest = (body: string): AIRequest =>
      AIRequestSchema.parse({
        model: WORKERS_AI_MODEL_ID,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ ...evidence, body }) },
        ],
        response_format: { type: 'json_schema', json_schema: AI_RESPONSE_JSON_SCHEMA },
        max_tokens: WORKERS_AI_MAX_OUTPUT_TOKENS,
        temperature: 0,
      });

    let request = makeRequest(cleanedBody);
    let serialized = JSON.stringify(request);
    const encoder = new TextEncoder();
    if (encoder.encode(serialized).byteLength > WORKERS_AI_MAX_REQUEST_UTF8_BYTES) {
      // Binary-search the COMPLETE serialized request, not the raw body. JSON escaping can expand
      // quotes and backslashes, so truncating by raw UTF-8 bytes alone is not a real request cap.
      const codePoints = Array.from(cleanedBody);
      let low = 0;
      let high = codePoints.length;
      let fittingRequest = makeRequest('');
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidateRequest = makeRequest(codePoints.slice(0, mid).join(''));
        const candidateBytes = encoder.encode(JSON.stringify(candidateRequest)).byteLength;
        if (candidateBytes <= WORKERS_AI_MAX_REQUEST_UTF8_BYTES) {
          fittingRequest = candidateRequest;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      request = fittingRequest;
      serialized = JSON.stringify(request);
    }
    const requestBytes = encoder.encode(serialized).byteLength;
    assertWorkersAiRequestSize(requestBytes);
    estimateWorkersAiNeurons(requestBytes);
    return request;
  }
}
