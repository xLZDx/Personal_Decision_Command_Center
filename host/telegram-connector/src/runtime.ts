/* global setInterval, clearInterval */
import type { NormalizedEvent } from '@pdos/contracts';

import { TelegramSession, type TelegramSessionEvent } from './session.js';
import { TelegramSpool, type SpoolItem } from './spool.js';

export interface TelegramConnectorRuntimeOptions {
  spool: TelegramSpool;
  deliver: (event: NormalizedEvent) => Promise<void>;
  now?: () => string;
  isPermanentError?: (error: unknown) => boolean;
  drainIntervalMs?: number;
}

export type TelegramDrainOutcome =
  | { outcome: 'EMPTY' }
  | { outcome: 'ACKED'; item: SpoolItem }
  | { outcome: 'LEASE_LOST'; item: SpoolItem }
  | { outcome: 'FAILED_RETRYABLE'; item: SpoolItem; error: unknown }
  | { outcome: 'FAILED_PERMANENT'; item: SpoolItem; error: unknown };

/**
 * Host-side connector orchestration. The session emits only eligible updates; every eligible
 * event is durably spooled before the runtime attempts network delivery. Delivery is ACKed only
 * after the injected ingest call resolves, so a crash leaves the item available on restart.
 */
export class TelegramConnectorRuntime {
  readonly #spool: TelegramSpool;
  readonly #deliver: (event: NormalizedEvent) => Promise<void>;
  readonly #now: () => string;
  readonly #isPermanentError: (error: unknown) => boolean;
  readonly #session: TelegramSession;
  #drainTail: Promise<void> = Promise.resolve();
  #drainTimer: ReturnType<typeof setInterval> | null = null;
  readonly #drainIntervalMs: number;

  constructor(options: TelegramConnectorRuntimeOptions) {
    this.#spool = options.spool;
    this.#deliver = options.deliver;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#isPermanentError = options.isPermanentError ?? (() => false);
    this.#drainIntervalMs = options.drainIntervalMs ?? 1000;
    if (!Number.isInteger(this.#drainIntervalMs) || this.#drainIntervalMs < 100) {
      throw new Error('drainIntervalMs must be an integer >= 100');
    }
    this.#session = new TelegramSession({
      now: this.#now,
      emit: async (event) => {
        this.#spool.enqueue(event, this.#now());
      },
    });
  }

  session(): TelegramSession {
    return this.#session;
  }

  async onMessage(update: TelegramSessionEvent): Promise<boolean> {
    return this.#session.onMessage(update);
  }

  start(): void {
    if (this.#drainTimer !== null) return;
    this.#drainTimer = setInterval(() => {
      void this.drainOnce().catch(() => undefined);
    }, this.#drainIntervalMs);
  }

  stop(): void {
    if (this.#drainTimer !== null) {
      clearInterval(this.#drainTimer);
      this.#drainTimer = null;
    }
  }

  async drainOnce(): Promise<TelegramDrainOutcome> {
    const result = this.#drainTail.then(() => this.#drainOnce());
    this.#drainTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #drainOnce(): Promise<TelegramDrainOutcome> {
    const item = this.#spool.claimReady(this.#now());
    if (item === null) return { outcome: 'EMPTY' };
    try {
      const heartbeat = setInterval(() => {
        try {
          this.#spool.renew(item.id, item.leaseToken, this.#now());
        } catch {
          // Delivery result remains authoritative; a subsequent claim will recover the item.
        }
      }, 10_000);
      try {
        await this.#deliver(item.event);
      } finally {
        clearInterval(heartbeat);
      }
      if (!this.#spool.ack(item.id, item.leaseToken)) {
        return { outcome: 'LEASE_LOST', item };
      }
      return { outcome: 'ACKED', item };
    } catch (error) {
      const permanent = this.#isPermanentError(error);
      this.#spool.fail(item.id, this.#now(), permanent, item.leaseToken);
      return {
        outcome: permanent ? 'FAILED_PERMANENT' : 'FAILED_RETRYABLE',
        item,
        error,
      };
    }
  }
}
