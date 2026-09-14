/* global Request, Response, URL, TextEncoder */
import type { ExportedHandler, Fetcher } from '@cloudflare/workers-types';

interface Env {
  CONTENT_GATEWAY: Fetcher;
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
}

const MAX_BODY_BYTES = 128 * 1024;

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Access-protected service-binding hop for the private Tunnel → Content Gateway path. */
async function fetch(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/telegram/content') {
    return new Response('not found', { status: 404 });
  }
  const clientId = request.headers.get('CF-Access-Client-Id') ?? '';
  const clientSecret = request.headers.get('CF-Access-Client-Secret') ?? '';
  if (!constantTimeEqual(clientId, env.ACCESS_CLIENT_ID) || !constantTimeEqual(clientSecret, env.ACCESS_CLIENT_SECRET)) {
    return new Response('unauthorized', { status: 401 });
  }
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BODY_BYTES) return new Response('payload too large', { status: 413 });
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) return new Response('payload too large', { status: 413 });
  return (await env.CONTENT_GATEWAY.fetch('https://internal.gateway/message', {
    method: 'POST',
    headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
    body,
  })) as unknown as Response;
}

export default {
  fetch: fetch as unknown as NonNullable<ExportedHandler<Env>['fetch']>,
} satisfies ExportedHandler<Env>;
