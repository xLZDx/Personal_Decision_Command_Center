/* global process */
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
}

/** Crash-safe host spool. It stores the strict normalized envelope, never Telegram raw content. */
export class TelegramSpool {
  readonly #db: SqliteDatabase;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_spool (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        event_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('PENDING','ACKED','FAILED_RETRYABLE','FAILED_PERMANENT')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_telegram_spool_ready
        ON telegram_spool (state, next_attempt_at, id);
    `);
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
    const row = this.#db
      .prepare(
        `SELECT id, event_json, state, attempts, next_attempt_at
         FROM telegram_spool
         WHERE state IN ('PENDING','FAILED_RETRYABLE') AND next_attempt_at <= ?
         ORDER BY id LIMIT 1`,
      )
      .get(now) as
      | {
          id: number;
          event_json: string;
          state: TelegramSpoolState;
          attempts: number;
          next_attempt_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      event: NormalizedEventSchema.parse(JSON.parse(row.event_json)),
      state: row.state,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
    };
  }

  ack(id: number): void {
    this.#db.prepare("UPDATE telegram_spool SET state = 'ACKED' WHERE id = ?").run(id);
  }

  fail(id: number, now: string, permanent = false): void {
    const next = permanent ? now : new Date(Date.parse(now) + 2_000).toISOString();
    this.#db
      .prepare(
        `UPDATE telegram_spool
         SET state = ?, attempts = attempts + 1, next_attempt_at = ?
         WHERE id = ?`,
      )
      .run(permanent ? 'FAILED_PERMANENT' : 'FAILED_RETRYABLE', next, id);
  }

  close(): void {
    this.#db.close();
  }
}
