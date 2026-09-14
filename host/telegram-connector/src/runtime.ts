import type { NormalizedEvent } from '@pdos/contracts';

import { TelegramSession, type TelegramSessionEvent } from './session.js';
import { TelegramSpool, type SpoolItem } from './spool.js';

export interface TelegramConnectorRuntimeOptions {
  spool: TelegramSpool;
  deliver: (event: NormalizedEvent) => Promise<void>;
  now?: () => string;
  isPermanentError?: (error: unknown) => boolean;
}

export type TelegramDrainOutcome =
  | { outcome: 'EMPTY' }
  | { outcome: 'ACKED'; item: SpoolItem }
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

  constructor(options: TelegramConnectorRuntimeOptions) {
    this.#spool = options.spool;
    this.#deliver = options.deliver;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#isPermanentError = options.isPermanentError ?? (() => false);
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
      await this.#deliver(item.event);
      this.#spool.ack(item.id);
      return { outcome: 'ACKED', item };
    } catch (error) {
      const permanent = this.#isPermanentError(error);
      this.#spool.fail(item.id, this.#now(), permanent);
      return {
        outcome: permanent ? 'FAILED_PERMANENT' : 'FAILED_RETRYABLE',
        item,
        error,
      };
    }
  }
}
