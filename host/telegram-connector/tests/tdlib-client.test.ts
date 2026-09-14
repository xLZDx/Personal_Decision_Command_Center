/* global setTimeout */
import { describe, expect, it } from 'vitest';
import { execPath } from 'node:process';
import { TelegramTdlibProcessClient } from '../src/index.js';

const event = {
  event_id: '00000000-0000-4000-8000-000000000071', source: 'telegram',
  source_account_id: 'tg-account', source_event_id: 'tg-message-71', source_thread_id: null,
  event_type: 'MESSAGE_CREATED', direction: 'INBOUND', occurred_at: '2026-09-14T10:01:00.000Z',
  occurred_at_quality: 'PROVIDER_REPORTED', received_at: '2026-09-14T10:00:00.000Z',
  content_locator: { kind: 'SOURCE_REF', ref: 'tg-message-71' }, routing_hints: [],
  source_policy_id: 'tg-policy', trace_id: 'trace-71', schema_version: 4, source_version: null,
};

describe('TelegramTdlibProcessClient', () => {
  it('bridges authorization and JSON updates from a bounded process stream', async () => {
    const states: string[] = [];
    const messages: unknown[] = [];
    const errors: unknown[] = [];
    const script = `const n=String.fromCharCode(10);process.stdout.write(JSON.stringify({authorization_state:{'@type':'authorizationStateReady'}})+n);process.stdout.write(JSON.stringify({kind:'message',event:${JSON.stringify(event)},initialCache:false})+n);setTimeout(()=>{},1000);`;
    const client = new TelegramTdlibProcessClient({
      command: execPath,
      args: ['-e', script],
      decodeUpdate: (value) => (typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'message' ? value as never : null),
      onError: (error) => errors.push(error),
    });
    client.onAuthorizationState((state) => states.push(state));
    client.onMessage((message) => messages.push(message));
    client.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    expect(states).toContain('READY');
    expect(messages).toHaveLength(1);
    expect(errors).toHaveLength(0);
    client.stop();
  });
});
