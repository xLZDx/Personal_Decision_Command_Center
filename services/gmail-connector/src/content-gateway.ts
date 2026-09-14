/* global Request, Response, URL */
import { importEcdsaP256PrivateJwk, signEcdsaP256Signature } from '@pdos/domain';
import type { GmailConnectorEnv } from './env.js';

interface ContentRequest {
  eventId: string;
  sourceAccountId: string;
  messageId: string;
}

interface GmailContent {
  subject: string;
  from: string;
  sentAt: string;
  plainText: string;
}

function canonical(value: ContentRequest & { content: GmailContent }): string {
  return [value.eventId, value.sourceAccountId, value.messageId, JSON.stringify(value.content)]
    .map((part) => `${part.length}:${part}`)
    .join('');
}

function parseRequest(value: unknown): ContentRequest {
  if (typeof value !== 'object' || value === null) throw new Error('invalid request');
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.eventId !== 'string' ||
    typeof candidate.sourceAccountId !== 'string' ||
    typeof candidate.messageId !== 'string' ||
    !candidate.eventId ||
    !candidate.sourceAccountId ||
    !candidate.messageId ||
    Object.keys(candidate).some((key) => !['eventId', 'sourceAccountId', 'messageId'].includes(key))
  )
    throw new Error('invalid request');
  return {
    eventId: candidate.eventId,
    sourceAccountId: candidate.sourceAccountId,
    messageId: candidate.messageId,
  };
}

function parseGmailContent(value: unknown): GmailContent {
  if (typeof value !== 'object' || value === null) throw new Error('invalid Gmail response');
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.subject !== 'string' ||
    typeof candidate.from !== 'string' ||
    typeof candidate.sentAt !== 'string' ||
    typeof candidate.plainText !== 'string'
  )
    throw new Error('invalid Gmail response');
  return {
    subject: candidate.subject,
    from: candidate.from,
    sentAt: candidate.sentAt,
    plainText: candidate.plainText,
  };
}

/** Internal service-binding endpoint. It signs exact bytes fetched from Gmail and nothing else. */
export async function handleContentGatewayRequest(
  request: Request,
  env: GmailConnectorEnv,
): Promise<Response> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/message') {
    return new Response('not found', { status: 404 });
  }
  try {
    const input = parseRequest(await request.json());
    const upstream = await env.GMAIL_API.fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(input.messageId)}`,
      { method: 'GET' },
    );
    if (!upstream.ok) return new Response('Gmail fetch failed', { status: 502 });
    const content = parseGmailContent(await upstream.json());
    const privateJwk = JSON.parse(env.GMAIL_CONTENT_SIGNING_PRIVATE_JWK) as Record<string, unknown>;
    const privateKey = await importEcdsaP256PrivateJwk(privateJwk);
    const attestation = { ...input, content };
    const signature = await signEcdsaP256Signature(privateKey, canonical(attestation));
    return Response.json({ ...attestation, signature });
  } catch {
    return new Response('invalid content gateway request', { status: 400 });
  }
}
