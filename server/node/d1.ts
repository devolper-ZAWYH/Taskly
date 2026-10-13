/**
 * The slice of Cloudflare D1's API the app uses, over a local SQLite file, for
 * running on a plain Node.js server (cPanel). D1 is SQLite too, so the SQL and
 * migrations are the same. The engine is Node's built-in `node:sqlite` (Node
 * 22.13+), else the `better-sqlite3` package if it's installed.
 *
 * Both engines are synchronous, so a batch runs start to finish without another
 * request getting in between; it's wrapped in a transaction like D1's.
 */

type Row = Record<string, unknown>

type SqliteStatement = {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
}

type SqliteDatabase = {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
}

type RunMeta = { changes: number; last_row_id: number; duration: number; changed_db: boolean }
type Result<T = Row> = { results: T[]; success: true; meta: RunMeta }

const NO_CHANGES: RunMeta = { changes: 0, last_row_id: 0, duration: 0, changed_db: false }

/**
 * Load the engine without an `import` statement, so the Cloudflare build never
 * sees these modules (they don't exist there).
 */
function openSqlite(path: string): SqliteDatabase {
  const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown })
    .getBuiltinModule
  if (!getBuiltin) throw new Error("Taskly needs Node.js 22.13 or newer.")
  const builtin = getBuiltin("node:sqlite") as
    | { DatabaseSync: new (path: string) => SqliteDatabase }
    | undefined
  if (builtin?.DatabaseSync) return new builtin.DatabaseSync(path)
  // Older Node: the better-sqlite3 package, installed next to the app.
  const { createRequire } = getBuiltin("node:module") as {
    createRequire: (from: string) => (id: string) => unknown
  }
  const BetterSqlite = createRequire(`${process.cwd()}/`)("better-sqlite3") as new (
    path: string,
  ) => SqliteDatabase
  return new BetterSqlite(path)
}

/** D1 accepts booleans and undefined; SQLite engines don't. */
function bindable(value: unknown): unknown {
  if (value === undefined) return null
  if (typeof value === "boolean") return value ? 1 : 0
  return value
}

/** Whether a statement hands back rows (D1's batch returns them for reads). */
function returnsRows(sql: string): boolean {
  return /^\s*(SELECT|WITH|PRAGMA|VALUES)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)
}

class Statement {
  constructor(
    private readonly db: SqliteDb,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): Statement {
    return new Statement(this.db, this.sql, values.map(bindable))
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.db.statement(this.sql).get(...this.params) as Row | undefined
    if (!row) return null
    return (column ? (row[column] ?? null) : row) as T | null
  }

  async all<T = Row>(): Promise<Result<T>> {
    return this.execute() as Result<T>
  }

  async run(): Promise<Result> {
    return this.execute()
  }

  /** Synchronous, for batches. */
  execute(): Result {
    const statement = this.db.statement(this.sql)
    if (returnsRows(this.sql)) {
      return { results: statement.all(...this.params) as Row[], success: true, meta: NO_CHANGES }
    }
    const info = statement.run(...this.params)
    const changes = Number(info.changes)
    return {
      results: [],
      success: true,
      meta: {
        changes,
        last_row_id: Number(info.lastInsertRowid),
        duration: 0,
        changed_db: changes > 0,
      },
    }
  }
}

class SqliteDb {
  private readonly cache = new Map<string, SqliteStatement>()

  constructor(private readonly sqlite: SqliteDatabase) {}

  statement(sql: string): SqliteStatement {
    let statement = this.cache.get(sql)
    if (!statement) {
      statement = this.sqlite.prepare(sql)
      this.cache.set(sql, statement)
    }
    return statement
  }

  prepare(sql: string): Statement {
    return new Statement(this, sql)
  }

  /** All or nothing, like D1. */
  async batch(statements: Statement[]): Promise<Result[]> {
    this.sqlite.exec("BEGIN IMMEDIATE")
    try {
      const results = statements.map((statement) => statement.execute())
      this.sqlite.exec("COMMIT")
      return results
    } catch (error) {
      this.sqlite.exec("ROLLBACK")
      throw error
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.sqlite.exec(sql)
    return { count: 0, duration: 0 }
  }
}

/** Open (or create) the database file, set up like D1: foreign keys on. */
export function openD1(path: string): D1Database {
  const sqlite = openSqlite(path)
  // WAL lets several app processes read while one writes; wait instead of failing when busy.
  sqlite.exec("PRAGMA journal_mode = WAL")
  sqlite.exec("PRAGMA busy_timeout = 5000")
  sqlite.exec("PRAGMA foreign_keys = ON")
  return new SqliteDb(sqlite) as unknown as D1Database
}
