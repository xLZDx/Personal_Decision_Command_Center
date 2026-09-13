/* global process */
import type { DatabaseSync as DatabaseSyncClass, StatementSync } from 'node:sqlite';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';

// `node:sqlite` is resolved via `process.getBuiltinModule` rather than a static `import`: Vite's
// bundled builtin-module list (which vitest's transform pipeline uses) predates this module, so a
// plain `import ... from 'node:sqlite'` fails to resolve under vitest even though Node itself
// supports it natively. `getBuiltinModule` is a plain runtime call, invisible to static analysis.
// The `import type` above is erased at compile time and never becomes a runtime module request.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

/**
 * A D1Database-shaped adapter over Node's built-in `node:sqlite`, for testing G2's domain package
 * without Miniflare/wrangler (not installed in this repo -- see core/DECISION_LOG.md). This is a
 * test-only shim: it targets the same PUBLIC D1 surface `packages/domain` and `services/*` code
 * against (`D1Database`/`D1PreparedStatement`/`D1Result` from `@cloudflare/workers-types`), not a
 * reimplementation of D1's internals, so the same domain code runs against this in tests and
 * against real D1 in production without a branch.
 *
 * Two behaviors are deliberately reproduced because domain code depends on them:
 * 1. `enableForeignKeyConstraints: true` -- D1 enforces FKs by default (Cloudflare-confirmed);
 *    a schema whose integrity relies on FK CHECKs must have them enforced in tests too.
 * 2. `batch()` is a single transaction, all-or-nothing -- matches Cloudflare's documented D1
 *    behavior, and the shared dead-letter-batch primitive (packages/domain) depends on both of its
 *    statements committing (or neither) atomically.
 */

const RETURNING_RE = /\breturning\b/i;

function toD1Meta(changes: number, lastInsertRowid: number | bigint) {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: changes,
    last_row_id: Number(lastInsertRowid),
    changed_db: changes > 0,
    changes,
  };
}

type Enqueue = <T>(fn: () => T) => Promise<T>;

class TestD1PreparedStatement implements D1PreparedStatement {
  readonly #db: DatabaseSyncClass;
  readonly #sql: string;
  readonly #params: unknown[];
  readonly #enqueue: Enqueue;

  constructor(db: DatabaseSyncClass, sql: string, enqueue: Enqueue, params: unknown[] = []) {
    this.#db = db;
    this.#sql = sql;
    this.#enqueue = enqueue;
    this.#params = params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new TestD1PreparedStatement(this.#db, this.#sql, this.#enqueue, values);
  }

  #statement(): StatementSync {
    return this.#db.prepare(this.#sql);
  }

  #firstSync<T>(colName?: string): T | null {
    const row = this.#statement().get(...(this.#params as never[])) as
      Record<string, unknown> | undefined;
    if (row === undefined) return null;
    if (colName !== undefined) return (row[colName] as T) ?? null;
    return row as T;
  }

  #runSync<T>(): D1Result<T> {
    // A statement carrying RETURNING must execute exactly once. `.run()` on node:sqlite discards
    // returned rows, so RETURNING statements are executed via `.all()` instead -- matches real D1,
    // which does populate `results` for a RETURNING statement passed to `.run()`.
    if (RETURNING_RE.test(this.#sql)) {
      return this.#allSync<T>();
    }
    const info = this.#statement().run(...(this.#params as never[]));
    return {
      success: true,
      meta: toD1Meta(Number(info.changes), info.lastInsertRowid),
      results: [],
    };
  }

  #allSync<T>(): D1Result<T> {
    const rows = this.#statement().all(...(this.#params as never[])) as T[];
    return {
      success: true,
      meta: toD1Meta(rows.length, 0),
      results: rows,
    };
  }

  #rawSync<T>(options?: { columnNames?: boolean }): T[] | [string[], ...T[]] {
    const rows = this.#statement().all(...(this.#params as never[])) as Record<string, unknown>[];
    const values = rows.map((row) => Object.values(row)) as T[];
    if (options?.columnNames) {
      const columns = rows.length > 0 && rows[0] !== undefined ? Object.keys(rows[0]) : [];
      return [columns, ...values] as [string[], ...T[]];
    }
    return values;
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    return this.#enqueue(() => this.#firstSync<T>(colName));
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.#enqueue(() => this.#runSync<T>());
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.#enqueue(() => this.#allSync<T>());
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    return this.#enqueue(() => this.#rawSync<T>(options));
  }

  // Executes immediately against node:sqlite, bypassing the write queue -- used ONLY by
  // createTestD1's own batch(), which already occupies the single queue slot for its whole
  // multi-statement transaction (database review, G2, Finding 2). Routing this through #enqueue
  // too would deadlock: the batch's own queue slot can never resolve while it waits on a nested
  // enqueue of itself. Not part of the D1PreparedStatement interface -- never call this from
  // outside this module.
  runRawForBatch<T = Record<string, unknown>>(): D1Result<T> {
    return this.#runSync<T>();
  }
}

export function createTestD1(schemaSql: string): D1Database {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  db.exec(schemaSql);

  // Real D1 is a single-writer system: concurrent calls against the SAME database -- whether a
  // multi-statement `batch()` or a single bare `.prepare().run()/.first()/.all()` -- are
  // transparently serialized, never interleaved. `node:sqlite` has no such queueing built in, so
  // without this, two `batch()` calls issued without awaiting one another would interleave their
  // BEGIN/COMMIT pairs and throw a shim-specific error with no real-D1 counterpart, AND a bare
  // statement racing an in-flight `batch()` could execute mid-transaction -- observing (or being
  // silently rolled back with) a partially-applied batch, which real D1 never allows (database
  // review, G2, Finding 2). This FIFO promise chain is the ONE queue every statement execution in
  // this module goes through -- `TestD1PreparedStatement`'s own public run()/first()/all()/raw()
  // enqueue onto it via `enqueue` below; only `batch()`'s internal per-statement execution bypasses
  // it (via `runRawForBatch`), because batch() itself already holds the single queue slot for its
  // whole transaction.
  let writeQueue: Promise<unknown> = Promise.resolve();
  const enqueue: Enqueue = (fn) => {
    const scheduled = writeQueue.then(fn, fn);
    // Swallow rejections in the queue chain itself (not in what callers observe) so one failed
    // statement/batch doesn't permanently wedge every later one behind a rejected promise.
    writeQueue = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  };

  return {
    prepare(query: string): D1PreparedStatement {
      return new TestD1PreparedStatement(db, query, enqueue);
    },
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const run = (): D1Result<T>[] => {
        db.exec('BEGIN');
        try {
          const results: D1Result<T>[] = [];
          for (const statement of statements) {
            results.push((statement as TestD1PreparedStatement).runRawForBatch<T>());
          }
          db.exec('COMMIT');
          return results;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      };
      return enqueue(run);
    },
    async exec(query: string) {
      db.exec(query);
      return { count: 0, duration: 0 };
    },
    // Not used by G2's domain code; present only to satisfy D1Database's shape.
    withSession() {
      throw new Error('createTestD1: withSession() is not supported by this test shim');
    },
    async dump(): Promise<ArrayBuffer> {
      throw new Error('createTestD1: dump() is not supported by this test shim');
    },
  } as D1Database;
}
