import type { NormalizedEvent } from '@pdos/contracts';

import { TelegramSession, type TelegramSessionEvent } from './session.js';

export interface TelegramTdlibUpdateSource {
  onAuthorizationState(
    listener: (state: 'WAITING' | 'READY' | 'OFFLINE' | 'CLOSED') => void,
  ): () => void;
  onMessage(listener: (update: TelegramSessionEvent) => void): () => void;
}

export interface TelegramTdlibAdapterOptions {
  source: TelegramTdlibUpdateSource;
  session: TelegramSession;
  normalizeMessage: (update: TelegramSessionEvent) => TelegramSessionEvent;
  onError: (error: unknown) => void;
  maxPendingUpdates?: number;
}

/**
 * Narrow TDLib adapter seam. TDLib-specific objects are decoded by `normalizeMessage` before they
 * cross this boundary; the session remains the sole authority for connected_at/cache filtering.
 */
export class TelegramTdlibAdapter {
  readonly #source: TelegramTdlibUpdateSource;
  readonly #session: TelegramSession;
  readonly #normalizeMessage: (update: TelegramSessionEvent) => TelegramSessionEvent;
  readonly #onError: (error: unknown) => void;
  readonly #maxPendingUpdates: number;
  #unsubscribe: (() => void) | null = null;
  #pendingUpdates = 0;
  #updateTail: Promise<void> = Promise.resolve();
  #epoch = 0;

  constructor(options: TelegramTdlibAdapterOptions) {
    this.#source = options.source;
    this.#session = options.session;
    this.#normalizeMessage = options.normalizeMessage;
    this.#onError = options.onError;
    this.#maxPendingUpdates = options.maxPendingUpdates ?? 256;
    if (!Number.isInteger(this.#maxPendingUpdates) || this.#maxPendingUpdates < 1) {
      throw new Error('maxPendingUpdates must be a positive integer');
    }
  }

  start(): void {
    if (this.#unsubscribe !== null) return;
    const epoch = ++this.#epoch;
    const stopAuthorization = this.#source.onAuthorizationState((state) => {
      this.#session.onAuthorizationState(state);
    });
    const stopMessages = this.#source.onMessage((update) => {
      if (this.#pendingUpdates >= this.#maxPendingUpdates) {
        try {
          this.#onError(new Error('Telegram TDLib update backlog exceeded'));
        } catch {
          // Error sinks are advisory and must not escape the TDLib callback.
        }
        return;
      }
      this.#pendingUpdates += 1;
      const run = this.#updateTail
        .then(() => {
          if (epoch !== this.#epoch) return null;
          return this.#normalizeMessage(update);
        })
        .then((normalized) => {
          if (normalized === null || epoch !== this.#epoch) return;
          return this.#session.onMessage(normalized);
        })
        .catch((error: unknown) => {
          try {
            this.#onError(error);
          } catch {
            // Error sinks must not create a second unhandled rejection in the adapter callback.
          }
        });
      this.#updateTail = run.then(
        () => {
          this.#pendingUpdates -= 1;
        },
        () => {
          this.#pendingUpdates -= 1;
        },
      );
    });
    this.#unsubscribe = () => {
      stopAuthorization();
      stopMessages();
      this.#unsubscribe = null;
    };
  }

  stop(): void {
    this.#epoch += 1;
    this.#unsubscribe?.();
  }

  health(): ReturnType<TelegramSession['health']> {
    return this.#session.health();
  }
}

export type TelegramNormalizedMessage = NormalizedEvent;
