import { NormalizedEventSchema, type NormalizedEvent } from '@pdos/contracts';

export type TelegramHealthState = 'DISCONNECTED' | 'AUTHENTICATING' | 'READY' | 'OFFLINE';

export interface TelegramSessionEvent {
  event: NormalizedEvent;
  /** TDLib marks messages delivered while filling its first-login local cache. */
  initialCache: boolean;
}

export interface TelegramSessionOptions {
  now?: () => string;
  emit: (event: NormalizedEvent) => Promise<void>;
}

export interface TelegramSessionHealth {
  state: TelegramHealthState;
  connectedAt: string | null;
  lastUpdateAt: string | null;
}

/**
 * TDLib-independent session boundary. The real TDLib adapter feeds authorization/update callbacks
 * into this class; central emission starts at connected_at and never backfills first-login cache.
 */
export class TelegramSession {
  readonly #now: () => string;
  readonly #emit: (event: NormalizedEvent) => Promise<void>;
  #health: TelegramSessionHealth = {
    state: 'DISCONNECTED',
    connectedAt: null,
    lastUpdateAt: null,
  };

  constructor(options: TelegramSessionOptions) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#emit = options.emit;
  }

  onAuthorizationState(state: 'WAITING' | 'READY' | 'OFFLINE' | 'CLOSED'): void {
    if (state === 'WAITING') {
      this.#health = { ...this.#health, state: 'AUTHENTICATING' };
    } else if (state === 'READY') {
      if (this.#health.state !== 'READY' || this.#health.connectedAt === null) {
        const connectedAt = this.#now();
        this.#health = { state: 'READY', connectedAt, lastUpdateAt: connectedAt };
      }
    } else if (state === 'OFFLINE') {
      this.#health = { ...this.#health, state: 'OFFLINE' };
    } else {
      this.#health = { ...this.#health, state: 'DISCONNECTED' };
    }
  }

  async onMessage(update: TelegramSessionEvent): Promise<boolean> {
    const normalized = NormalizedEventSchema.parse(update.event);
    if (!this.isEligible({ ...update, event: normalized })) return false;
    this.#health = { ...this.#health, lastUpdateAt: this.#now() };
    await this.#emit(normalized);
    return true;
  }

  /** Eligibility check used by durable overflow sinks before bypassing normal emission. */
  isEligible(update: TelegramSessionEvent): boolean {
    if (this.#health.state !== 'READY' || this.#health.connectedAt === null) return false;
    const normalized = NormalizedEventSchema.parse(update.event);
    return !update.initialCache && Date.parse(normalized.occurred_at) >= Date.parse(this.#health.connectedAt);
  }

  health(): TelegramSessionHealth {
    return { ...this.#health };
  }
}
