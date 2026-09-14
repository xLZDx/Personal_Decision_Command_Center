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
  #unsubscribe: (() => void) | null = null;

  constructor(options: TelegramTdlibAdapterOptions) {
    this.#source = options.source;
    this.#session = options.session;
    this.#normalizeMessage = options.normalizeMessage;
    this.#onError = options.onError;
  }

  start(): void {
    if (this.#unsubscribe !== null) return;
    const stopAuthorization = this.#source.onAuthorizationState((state) => {
      this.#session.onAuthorizationState(state);
    });
    const stopMessages = this.#source.onMessage((update) => {
      void Promise.resolve()
        .then(() => this.#normalizeMessage(update))
        .then((normalized) => this.#session.onMessage(normalized))
        .catch((error: unknown) => this.#onError(error));
    });
    this.#unsubscribe = () => {
      stopAuthorization();
      stopMessages();
      this.#unsubscribe = null;
    };
  }

  stop(): void {
    this.#unsubscribe?.();
  }

  health(): ReturnType<TelegramSession['health']> {
    return this.#session.health();
  }
}

export type TelegramNormalizedMessage = NormalizedEvent;
