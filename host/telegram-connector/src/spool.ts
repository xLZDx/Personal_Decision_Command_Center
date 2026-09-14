/* global process */
import { randomUUID } from 'node:crypto';
import { NormalizedEventSchema, type NormalizedEvent } from '@pdos/contracts';

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

// Vite cannot statically resolve node:sqlite in Workers-oriented test bundles; Node resolves this
// builtin at runtime on the always-on connector host.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as unknown as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

export type TelegramSpoolState = 'PENDING' | 'ACKED' | 'FAILED_RETRYABLE' | 'FAILED_PERMANENT';

export interface SpoolItem {
  id: number;
  event: NormalizedEvent;
  state: TelegramSpoolState;
  attempts: number;
  nextAttemptAt: string;
  leaseToken: string;
}

export interface TelegramSpoolOptions {
  retryBaseMs?: number;
  retryCapMs?: number;
  random?: () => number;
}

/** Crash-safe host spool. It stores the strict normalized envelope, never Telegram raw content. */
export class TelegramSpool {
  readonly #db: SqliteDatabase;
  readonly #retryBaseMs: number;
  readonly #retryCapMs: number;
  readonly #random: () => number;

  constructor(path: string, options: TelegramSpoolOptions = {}) {
    this.#db = new DatabaseSync(path);
    this.#retryBaseMs = options.retryBaseMs ?? 2_000;
    this.#retryCapMs = options.retryCapMs ?? 5 * 60_000;
    this.#random = options.random ?? Math.random;
    if (!Number.isFinite(this.#retryBaseMs) || this.#retryBaseMs <= 0) {
      throw new Error('retryBaseMs must be positive');
    }
    if (!Number.isFinite(this.#retryCapMs) || this.#retryCapMs < this.#retryBaseMs) {
      throw new Error('retryCapMs must be >= retryBaseMs');
    }
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_spool (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        event_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('PENDING','ACKED','FAILED_RETRYABLE','FAILED_PERMANENT')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        lease_token TEXT,
        lease_until TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_telegram_spool_ready
        ON telegram_spool (state, next_attempt_at, id);
    `);
    try {
      this.#db.exec('ALTER TABLE telegram_spool ADD COLUMN lease_token TEXT');
    } catch {
      // Existing databases created by this module already have the lease columns.
    }
    try {
      this.#db.exec('ALTER TABLE telegram_spool ADD COLUMN lease_until TEXT');
    } catch {
      // Existing databases created by this module already have the lease columns.
    }
  }

  enqueue(event: NormalizedEvent, now: string): boolean {
    const parsed = NormalizedEventSchema.parse(event);
    const result = this.#db
      .prepare(
        `INSERT INTO telegram_spool (event_id, event_json, state, attempts, next_attempt_at)
         VALUES (?, ?, 'PENDING', 0, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .run(parsed.event_id, JSON.stringify(parsed), now);
    return Number(result.changes) === 1;
  }

  claimReady(now: string): SpoolItem | null {
    const leaseToken = randomUUID();
    const leaseUntil = new Date(Date.parse(now) + 30_000).toISOString();
    const row = this.#db
      .prepare(
        `UPDATE telegram_spool
         SET lease_token = ?, lease_until = ?
         WHERE id = (
           SELECT id FROM telegram_spool
           WHERE state IN ('PENDING','FAILED_RETRYABLE')
             AND next_attempt_at <= ?
             AND (lease_token IS NULL OR lease_until <= ?)
           ORDER BY id LIMIT 1
         )
         RETURNING id, event_json, state, attempts, next_attempt_at, lease_token`,
      )
      .get(leaseToken, leaseUntil, now, now) as
      | {
          id: number;
          event_json: string;
          state: TelegramSpoolState;
          attempts: number;
          next_attempt_at: string;
          lease_token: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      event: NormalizedEventSchema.parse(JSON.parse(row.event_json)),
      state: row.state,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      leaseToken: row.lease_token,
    };
  }

  ack(id: number, leaseToken: string): void {
    this.#db
      .prepare(
        "UPDATE telegram_spool SET state = 'ACKED', lease_token = NULL, lease_until = NULL WHERE id = ? AND lease_token = ?",
      )
      .run(id, leaseToken);
  }

  fail(id: number, now: string, permanent: boolean, leaseToken: string): void {
    const nextAttempt = this.#db
      .prepare('SELECT attempts FROM telegram_spool WHERE id = ? AND lease_token = ?')
      .get(id, leaseToken) as { attempts: number } | undefined;
    if (!nextAttempt) return;
    const attempt = Number(nextAttempt?.attempts ?? 0) + 1;
    const exponential = Math.min(this.#retryBaseMs * 2 ** (attempt - 1), this.#retryCapMs);
    const jitter = Math.floor(exponential * 0.2 * Math.min(1, Math.max(0, this.#random())));
    const next = permanent
      ? now
      : new Date(Date.parse(now) + Math.min(this.#retryCapMs, exponential + jitter)).toISOString();
    this.#db
      .prepare(
        `UPDATE telegram_spool
         SET state = ?, attempts = attempts + 1, next_attempt_at = ?
           , lease_token = NULL, lease_until = NULL
         WHERE id = ? AND lease_token = ?`,
      )
      .run(permanent ? 'FAILED_PERMANENT' : 'FAILED_RETRYABLE', next, id, leaseToken);
  }

  close(): void {
    this.#db.close();
  }
}
