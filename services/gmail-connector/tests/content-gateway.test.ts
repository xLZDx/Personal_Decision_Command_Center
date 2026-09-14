/* global crypto, Request, Response, URL, AbortSignal, AbortController, setTimeout */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { verifyEcdsaP256Signature } from '@pdos/domain';

import { handleContentGatewayRequest } from '../src/index.js';

let privateJwk: Record<string, unknown>;
let publicJwk: Parameters<typeof verifyEcdsaP256Signature>[0];

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as Record<string, unknown>;
  publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as typeof publicJwk;
});

describe('Gmail content gateway', () => {
  it('returns connector-signed content bound to explicit event/account/message identities', async () => {
    const upstream = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            subject: 'Subject',
            from: 'sender@example.test',
            sentAt: '2026-09-14T08:00:00.000Z',
            plainText: 'Body',
          }),
        ),
    );
    const response = await handleContentGatewayRequest(
      new Request('https://gateway.internal/message', {
        method: 'POST',
        body: JSON.stringify({
          eventId: 'pdos-event',
          sourceAccountId: 'acct',
          messageId: 'gmail-opaque',
        }),
      }),
      {
        GMAIL_API: { fetch: upstream } as never,
        GMAIL_CONTENT_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      eventId: string;
      sourceAccountId: string;
      messageId: string;
      content: Record<string, string>;
      signature: string;
    };
    const canonical = [
      body.eventId,
      body.sourceAccountId,
      body.messageId,
      JSON.stringify(body.content),
    ]
      .map((part) => `${part.length}:${part}`)
      .join('');
    expect(await verifyEcdsaP256Signature(publicJwk, canonical, body.signature)).toBe(true);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('rejects malformed pointer requests before calling Gmail', async () => {
    const upstream = vi.fn();
    const response = await handleContentGatewayRequest(
      new Request('https://gateway.internal/message', {
        method: 'POST',
        body: JSON.stringify({ eventId: 'e', sourceAccountId: 'a', messageId: 'm', body: 'raw' }),
      }),
      {
        GMAIL_API: { fetch: upstream } as never,
        GMAIL_CONTENT_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
      },
    );
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('propagates caller cancellation to the downstream Gmail adapter', async () => {
    const controller = new AbortController();
    let downstreamSignal: AbortSignal | undefined;
    const upstream = vi.fn(async (_input: unknown, init?: { signal?: AbortSignal }) => {
      downstreamSignal = init?.signal;
      await new Promise<never>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('downstream aborted')), {
          once: true,
        });
      });
      throw new Error('unreachable');
    });
    const responsePromise = handleContentGatewayRequest(
      new Request('https://gateway.internal/message', {
        method: 'POST',
        body: JSON.stringify({ eventId: 'e', sourceAccountId: 'a', messageId: 'm' }),
        signal: controller.signal,
      }),
      {
        GMAIL_API: { fetch: upstream } as never,
        GMAIL_CONTENT_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
      },
    );
    while (!downstreamSignal) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect((await responsePromise).status).toBe(400);
    expect(downstreamSignal?.aborted).toBe(true);
  });

  it('keeps the content gateway off the public workers.dev route', async () => {
    const wrangler = await readFile(
      new URL('../../../infra/cloudflare/gmail-connector.wrangler.toml', import.meta.url),
      'utf8',
    );
    expect(wrangler).toMatch(/(^|\n)workers_dev\s*=\s*false(?:\n|$)/);
  });
});
