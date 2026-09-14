import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Buffer } from 'node:buffer';

import type { TelegramSessionEvent } from './session.js';
import type { TelegramTdlibUpdateSource } from './tdlib-adapter.js';

const MAX_STDOUT_LINE_BYTES = 256 * 1024;

export interface TelegramTdlibProcessClientOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Converts one decoded TDLib update into the host's normalized session event. */
  decodeUpdate: (value: unknown) => TelegramSessionEvent | null;
  onError: (error: unknown) => void;
}

/**
 * Concrete process bridge for a pinned TDLib JSON client. The native TDLib binding/container is
 * deliberately injected as a command; no Telegram content is logged, and stdout framing is
 * bounded before JSON parsing. This implements the same source contract used by the adapter.
 */
export class TelegramTdlibProcessClient implements TelegramTdlibUpdateSource {
  readonly #options: TelegramTdlibProcessClientOptions;
  readonly #authorizationListeners = new Set<
    (state: 'WAITING' | 'READY' | 'OFFLINE' | 'CLOSED') => void
  >();
  readonly #messageListeners = new Set<(update: TelegramSessionEvent) => void>();
  #child: ChildProcessWithoutNullStreams | null = null;
  #stdoutBuffer = '';

  constructor(options: TelegramTdlibProcessClientOptions) {
    this.#options = options;
    if (options.command.trim().length === 0) throw new Error('TDLib command is required');
  }

  onAuthorizationState(
    listener: (state: 'WAITING' | 'READY' | 'OFFLINE' | 'CLOSED') => void,
  ): () => void {
    this.#authorizationListeners.add(listener);
    return () => this.#authorizationListeners.delete(listener);
  }

  onMessage(listener: (update: TelegramSessionEvent) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  start(): void {
    if (this.#child !== null) return;
    const child = spawn(this.#options.command, [...(this.#options.args ?? [])], {
      cwd: this.#options.cwd,
      env: this.#options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#onStdout(chunk));
    child.stderr.on('data', () => {
      // TDLib stderr may contain provider text; intentionally do not forward/log it.
    });
    child.once('error', (error) => this.#report(error));
    child.once('close', () => {
      if (this.#child === child) this.#child = null;
      this.#emitAuthorization('CLOSED');
    });
  }

  stop(): void {
    const child = this.#child;
    this.#child = null;
    if (child !== null && !child.killed) child.kill('SIGTERM');
    this.#stdoutBuffer = '';
    this.#emitAuthorization('CLOSED');
  }

  /** Sends one TDLib request (for login/authorization or cursor synchronization). */
  send(request: Record<string, unknown>): void {
    const child = this.#child;
    if (child === null || child.stdin.destroyed) throw new Error('TDLib process is not running');
    const encoded = JSON.stringify(request);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_STDOUT_LINE_BYTES) {
      throw new Error('TDLib request exceeds size limit');
    }
    child.stdin.write(`${encoded}\n`);
  }

  #onStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    if (Buffer.byteLength(this.#stdoutBuffer, 'utf8') > MAX_STDOUT_LINE_BYTES * 2) {
      this.#stdoutBuffer = '';
      this.#report(new Error('TDLib stdout frame exceeds size limit'));
      return;
    }
    let newline = this.#stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.#onLine(line);
      newline = this.#stdoutBuffer.indexOf('\n');
    }
  }

  #onLine(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > MAX_STDOUT_LINE_BYTES) {
      this.#report(new Error('TDLib JSON frame exceeds size limit'));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      this.#report(new Error('TDLib emitted invalid JSON'));
      return;
    }
    if (isAuthorizationUpdate(value)) {
      this.#emitAuthorization(mapAuthorization(value.authorization_state['@type']));
      return;
    }
    try {
      const decoded = this.#options.decodeUpdate(value);
      if (decoded === null) return;
      for (const listener of this.#messageListeners) listener(decoded);
    } catch (error) {
      this.#report(error);
    }
  }

  #emitAuthorization(state: 'WAITING' | 'READY' | 'OFFLINE' | 'CLOSED'): void {
    for (const listener of this.#authorizationListeners) {
      try {
        listener(state);
      } catch (error) {
        this.#report(error);
      }
    }
  }

  #report(error: unknown): void {
    try {
      this.#options.onError(error);
    } catch {
      // Error sinks cannot escape process callbacks.
    }
  }
}

function isAuthorizationUpdate(
  value: unknown,
): value is { authorization_state: { '@type': string } } {
  return (
    typeof value === 'object' && value !== null &&
    'authorization_state' in value &&
    typeof value.authorization_state === 'object' && value.authorization_state !== null &&
    '@type' in value.authorization_state && typeof value.authorization_state['@type'] === 'string'
  );
}

function mapAuthorization(type: string): 'WAITING' | 'READY' | 'OFFLINE' | 'CLOSED' {
  if (type === 'authorizationStateReady') return 'READY';
  if (type === 'authorizationStateClosed') return 'CLOSED';
  if (type === 'authorizationStateWaitCode' || type === 'authorizationStateWaitPhoneNumber' || type === 'authorizationStateWaitPassword') return 'WAITING';
  return 'OFFLINE';
}
